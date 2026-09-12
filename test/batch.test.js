#!/usr/bin/env node
/**
 * 调校批次管理端到端测试（零依赖，Node >= 18）。
 * 运行：node test/batch.test.js
 *
 * 覆盖：
 *   1. 正常流转：建批 -> 多钟挂入 -> 初测 -> 调校 -> 两次复测合格 -> 验收 -> 批次完成，
 *      且服务重启后数据仍可查询（持久化）。
 *   2. 重复挂钟 / 幂等：同一钟表重复挂入同一批次不产生新记录；同一钟表挂入另一个
 *      未完成批次被拒；相同 code 重复创建批次不生成新记录。
 *   3. 并发验收：同一钟表并发验收只有一次成功，审计只有一条 accepted。
 *   4. 失败恢复：复测不合格回退调校、提前验收被拒且写审计，重新调校并连续两次复测
 *      合格后验收成功；摆幅边界 180/320 判定。
 */

const { spawn } = require("child_process");
const { mkdtemp, rm, readFile } = require("fs/promises");
const os = require("os");
const path = require("path");
const assert = require("assert");

const SERVER = path.join(__dirname, "..", "server.js");
let server = null;
let baseUrl = "";
let tmpDir = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer(dbFile) {
  const port = 31000 + Math.floor(Math.random() * 4000);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DB_FILE: dbFile }
  });
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 10000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("running")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出，code=${code}`));
    });
  });
  return { child, port, started };
}

async function waitHealthy(url, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      /* 等待服务起来 */
    }
    await sleep(100);
  }
  throw new Error("健康检查一直失败");
}

async function boot() {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "clock-batch-test-"));
  const dbFile = path.join(tmpDir, "db.json");
  const { child, port } = await startServer(dbFile);
  server = child;
  baseUrl = `http://127.0.0.1:${port}`;
  await waitHealthy(baseUrl);
  return dbFile;
}

async function restart(dbFile) {
  await shutdown();
  const { child, port } = await startServer(dbFile);
  server = child;
  baseUrl = `http://127.0.0.1:${port}`;
  await waitHealthy(baseUrl);
}

function shutdown() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const child = server;
    server = null;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function api(method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, body: json };
}

async function createClock(code, targetDailyRateSeconds = 20) {
  const res = await api("POST", "/clocks", {
    code,
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    targetDailyRateSeconds,
    note: `测试钟 ${code}`
  });
  assert.strictEqual(res.status, 201, `创建钟表失败: ${JSON.stringify(res.body)}`);
  return res.body.data.id;
}

async function createBatch(code, extra = {}) {
  return api("POST", "/batches", { code, technician: "王技师", note: "批次测试", ...extra });
}

function memberOf(batch, clockId) {
  const member = batch.members.find((item) => item.clockId === clockId);
  assert.ok(member, "批次中找不到该成员");
  return member;
}

// 调校 -> 复测一条腿。qualified=true 表示该次复测落在目标范围且摆幅合法
async function adjustAndRetest(batchId, clockId, { rate, amp, adjustmentRate }) {
  const adj = await api("POST", `/batches/${batchId}/clocks/${clockId}/adjustments`, {
    currentDailyRateSeconds: adjustmentRate ?? rate,
    direction: "慢针方向",
    amount: "游丝快慢针向慢侧微调0.2格"
  });
  assert.strictEqual(adj.status, 201, `调校失败: ${JSON.stringify(adj.body)}`);
  const retest = await api("POST", `/batches/${batchId}/clocks/${clockId}/retests`, {
    dailyRateSeconds: rate,
    amplitude: amp,
    note: "测试复测"
  });
  assert.strictEqual(retest.status, 201, `复测失败: ${JSON.stringify(retest.body)}`);
  return retest.body.data;
}

async function auditList(query = "") {
  const res = await api("GET", `/audit${query}`);
  assert.strictEqual(res.status, 200);
  return res.body.data;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------- 1. 正常流转 + 重启持久化 ----------

test("正常流转：两只钟挂入同一批次，连续两次复测合格后验收，批次自动完成", async () => {
  const clockA = await createClock("FLOW-A");
  const clockB = await createClock("FLOW-B");

  const created = await createBatch("BATCH-FLOW-001");
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.deduplicated, false);
  const batchId = created.body.data.id;

  // 一次挂入多只钟
  const attach = await api("POST", `/batches/${batchId}/clocks`, { clockIds: [clockA, clockB] });
  assert.strictEqual(attach.status, 201);
  assert.deepStrictEqual(attach.body.attached.sort(), [clockA, clockB]);
  assert.strictEqual(attach.body.data.members.length, 2);

  for (const clockId of [clockA, clockB]) {
    // 初测
    const init = await api("POST", `/batches/${batchId}/clocks/${clockId}/initial-tests`, {
      dailyRateSeconds: 75,
      amplitude: 220,
      note: "初测走时偏快"
    });
    assert.strictEqual(init.status, 201);
    assert.strictEqual(init.body.data.member.stage, "adjusting");

    // 第一次复测合格（误差 12 <= 20，摆幅 250 在 180..320）
    const first = await adjustAndRetest(batchId, clockId, { rate: 12, amp: 250 });
    assert.strictEqual(first.retest.qualified, true);
    assert.strictEqual(first.member.passStreak, 1);
    assert.strictEqual(first.member.stage, "retesting", "仅一次合格还不能验收，应继续复测");

    // 不重新调校也可连续复测
    const second = await api("POST", `/batches/${batchId}/clocks/${clockId}/retests`, {
      dailyRateSeconds: -8,
      amplitude: 240
    });
    assert.strictEqual(second.status, 201);
    assert.strictEqual(second.body.data.retest.qualified, true);
    assert.strictEqual(second.body.data.member.passStreak, 2);

    const accept = await api("POST", `/batches/${batchId}/clocks/${clockId}/acceptance`, {});
    assert.strictEqual(accept.status, 200, `验收失败: ${JSON.stringify(accept.body)}`);
    assert.strictEqual(accept.body.data.member.stage, "accepted");
  }

  const done = await api("GET", `/batches/${batchId}`);
  assert.strictEqual(done.body.data.status, "completed", "全部验收后批次应自动完成");
  assert.ok(done.body.data.finishedAt);

  // 所有动作都有审计记录
  const audit = await auditList(`?batchId=${batchId}`);
  const actions = audit.map((item) => item.action);
  for (const action of ["batch.create", "clock.attach", "initial_test", "adjustment", "retest", "acceptance", "batch.complete"]) {
    assert.ok(actions.includes(action), `审计缺少动作 ${action}`);
  }
  const acceptedCount = audit.filter(
    (item) => item.action === "acceptance" && item.result === "accepted"
  ).length;
  assert.strictEqual(acceptedCount, 2);
  // 两只钟各 1 次调校、各 2 次复测
  assert.strictEqual(audit.filter((item) => item.action === "adjustment").length, 2);
  assert.strictEqual(audit.filter((item) => item.action === "retest").length, 4);
});

test("服务重启后批次、成员状态、复测和审计仍可查询", async () => {
  const listing = await api("GET", "/batches?status=completed");
  assert.strictEqual(listing.status, 200);
  const before = listing.body.data.find((item) => item.code === "BATCH-FLOW-001");
  assert.ok(before, "重启前找不到批次");

  await restart(global.__dbFile);

  const after = await api("GET", `/batches/${before.id}`);
  assert.strictEqual(after.status, 200);
  assert.strictEqual(after.body.data.status, "completed");
  assert.strictEqual(after.body.data.members.length, 2);
  for (const member of after.body.data.members) {
    assert.strictEqual(member.stage, "accepted");
    assert.ok(member.acceptedAt);
  }
  const audit = await auditList(`?batchId=${before.id}`);
  assert.ok(audit.length >= 9, "重启后审计记录丢失");
});

// ---------- 2. 重复挂钟 / 幂等 ----------

test("重复创建批次不生成新记录；重复挂钟幂等；跨未完成批次挂钟被拒；完成后可再挂", async () => {
  const clockC = await createClock("FLOW-C");
  const clockD = await createClock("FLOW-D");
  const clockE = await createClock("FLOW-E");

  // 相同 code 重复创建 -> 同一条记录
  const first = await createBatch("BATCH-IDEMPOTENT-001");
  assert.strictEqual(first.status, 201);
  const dup = await createBatch("BATCH-IDEMPOTENT-001", { note: "参数不同也应幂等" });
  assert.strictEqual(dup.status, 200);
  assert.strictEqual(dup.body.deduplicated, true);
  assert.strictEqual(dup.body.data.id, first.body.data.id);

  // idempotencyKey 也能去重
  const keyedA = await createBatch("BATCH-KEY-001", { idempotencyKey: "key-xyz" });
  const keyedB = await createBatch("BATCH-KEY-002", { idempotencyKey: "key-xyz" });
  assert.strictEqual(keyedB.status, 200);
  assert.strictEqual(keyedB.body.data.id, keyedA.body.data.id);

  const list = await api("GET", "/batches");
  assert.strictEqual(list.body.data.filter((item) => item.code === "BATCH-IDEMPOTENT-001").length, 1);

  const batch1 = first.body.data.id;
  const attach = await api("POST", `/batches/${batch1}/clocks`, { clockIds: [clockC, clockD] });
  assert.strictEqual(attach.status, 201);

  // 重复挂入同一批次：不新增成员，返回既有
  const reAttach = await api("POST", `/batches/${batch1}/clocks`, { clockIds: [clockC, clockE] });
  assert.strictEqual(reAttach.status, 201);
  assert.deepStrictEqual(reAttach.body.existed, [clockC]);
  assert.deepStrictEqual(reAttach.body.attached, [clockE]);
  assert.strictEqual(reAttach.body.data.members.length, 3);
  const attachAudit = await auditList(`?batchId=${batch1}&action=clock.attach`);
  assert.strictEqual(attachAudit.length, 3, "幂等挂钟不应写审计/新记录");

  // 同一钟表挂入另一个未完成批次 -> 409
  const other = await createBatch("BATCH-IDEMPOTENT-002");
  const conflict = await api("POST", `/batches/${other.body.data.id}/clocks`, { clockIds: [clockC] });
  assert.strictEqual(conflict.status, 409);
  assert.match(conflict.body.error, /未完成批次/);

  // 让 batch1 走完并完成（钟 C：初测 -> 调校 -> 两连过 -> 验收；其余成员也要验收）
  for (const clockId of [clockC, clockD, clockE]) {
    await api("POST", `/batches/${batch1}/clocks/${clockId}/initial-tests`, {
      dailyRateSeconds: 60,
      amplitude: 210
    });
    await adjustAndRetest(batch1, clockId, { rate: 10, amp: 230 });
    const second = await api("POST", `/batches/${batch1}/clocks/${clockId}/retests`, {
      dailyRateSeconds: 9,
      amplitude: 235
    });
    assert.strictEqual(second.body.data.member.passStreak, 2);
    const accept = await api("POST", `/batches/${batch1}/clocks/${clockId}/acceptance`, {});
    assert.strictEqual(accept.status, 200);
  }
  const finished = await api("GET", `/batches/${batch1}`);
  assert.strictEqual(finished.body.data.status, "completed");

  // 批次完成后，同一钟表可以进入新批次
  const again = await api("POST", `/batches/${other.body.data.id}/clocks`, { clockIds: [clockC] });
  assert.strictEqual(again.status, 201);
  assert.deepStrictEqual(again.body.attached, [clockC]);
});

// ---------- 3. 并发验收 ----------

test("并发验收：只有一次成功，其余全部冲突，审计只有一条 accepted", async () => {
  const clockF = await createClock("CONC-F");
  const batch = await createBatch("BATCH-CONCURRENT-001");
  const batchId = batch.body.data.id;
  await api("POST", `/batches/${batchId}/clocks`, { clockIds: [clockF] });
  await api("POST", `/batches/${batchId}/clocks/${clockF}/initial-tests`, {
    dailyRateSeconds: 55,
    amplitude: 220
  });
  await adjustAndRetest(batchId, clockF, { rate: 5, amp: 260 });
  await api("POST", `/batches/${batchId}/clocks/${clockF}/retests`, {
    dailyRateSeconds: 6,
    amplitude: 258
  });
  const concurrency = 12;
  const results = await Promise.all(
    Array.from({ length: concurrency }, () =>
      api("POST", `/batches/${batchId}/clocks/${clockF}/acceptance`, {})
    )
  );
  const okCount = results.filter((item) => item.status === 200).length;
  const conflictCount = results.filter((item) => item.status === 409).length;
  assert.strictEqual(okCount, 1, `应有且仅有一次验收成功，实际 ${okCount}`);
  assert.strictEqual(conflictCount, concurrency - 1, "其余并发验收应全部报 409");

  const audit = await auditList(`?batchId=${batchId}&clockId=${clockF}&action=acceptance`);
  assert.strictEqual(
    audit.filter((item) => item.result === "accepted").length,
    1,
    "accepted 审计必须恰好一条"
  );

  const fetched = await api("GET", `/batches/${batchId}`);
  assert.strictEqual(memberOf(fetched.body.data, clockF).stage, "accepted");
});

// ---------- 4. 失败恢复 ----------

test("失败恢复：复测不合格回退调校，提前验收被拒并写审计，恢复后可验收", async () => {
  const clockG = await createClock("RECOVER-G");
  const clockH = await createClock("RECOVER-H");
  const batch = await createBatch("BATCH-RECOVER-001");
  const batchId = batch.body.data.id;
  await api("POST", `/batches/${batchId}/clocks`, { clockIds: [clockG, clockH] });

  await api("POST", `/batches/${batchId}/clocks/${clockG}/initial-tests`, {
    dailyRateSeconds: 90,
    amplitude: 200
  });

  // 第一次复测合格
  await adjustAndRetest(batchId, clockG, { rate: 15, amp: 220 });

  // 状态机保护：未连续两次合格就验收 -> 422 且写 rejected 审计
  const premature = await api("POST", `/batches/${batchId}/clocks/${clockG}/acceptance`, {});
  assert.strictEqual(premature.status, 422);
  assert.match(premature.body.error, /insufficient_consecutive_passes/);

  // 第二次复测不合格（误差超目标）：连中断，必须回到调校
  const failed = await api("POST", `/batches/${batchId}/clocks/${clockG}/retests`, {
    dailyRateSeconds: 45,
    amplitude: 250
  });
  assert.strictEqual(failed.status, 201);
  assert.strictEqual(failed.body.data.retest.qualified, false);
  assert.strictEqual(failed.body.data.retest.rateInRange, false);
  assert.strictEqual(failed.body.data.retest.amplitudeInRange, true);
  assert.strictEqual(failed.body.data.member.stage, "adjusting");
  assert.strictEqual(failed.body.data.member.passStreak, 0);

  // 回到复测阶段前不允许复测
  const noRetest = await api("POST", `/batches/${batchId}/clocks/${clockG}/retests`, {
    dailyRateSeconds: 5,
    amplitude: 250
  });
  assert.strictEqual(noRetest.status, 409);

  // 重新调校 -> 第一次复测合格 -> 第二次摆幅 321 超标（边界外），不合格，再次回退
  await adjustAndRetest(batchId, clockG, { rate: 10, amp: 240 });
  const ampHigh = await api("POST", `/batches/${batchId}/clocks/${clockG}/retests`, {
    dailyRateSeconds: 8,
    amplitude: 321
  });
  assert.strictEqual(ampHigh.body.data.retest.amplitudeInRange, false);
  assert.strictEqual(ampHigh.body.data.retest.qualified, false);
  assert.strictEqual(ampHigh.body.data.member.stage, "adjusting");

  // 恢复：重新调校（该复测为连续合格的第 1 次，摆幅 180 为下边界）
  const recover1 = await adjustAndRetest(batchId, clockG, { rate: 9, amp: 180 });
  assert.strictEqual(recover1.retest.qualified, true, "摆幅 180 应为合法边界");
  assert.strictEqual(recover1.member.passStreak, 1);
  const pass2 = await api("POST", `/batches/${batchId}/clocks/${clockG}/retests`, {
    dailyRateSeconds: -11,
    amplitude: 320
  });
  assert.strictEqual(pass2.body.data.retest.qualified, true, "摆幅 320 应为合法边界");
  assert.strictEqual(pass2.body.data.member.passStreak, 2);

  const acceptG = await api("POST", `/batches/${batchId}/clocks/${clockG}/acceptance`, {});
  assert.strictEqual(acceptG.status, 200);
  assert.strictEqual(acceptG.body.data.member.stage, "accepted");

  // 另一成员还没完成，批次必须仍 open
  const open = await api("GET", `/batches/${batchId}`);
  assert.strictEqual(open.body.data.status, "open");

  // 已验收的钟不能重复验收
  const doubleAccept = await api("POST", `/batches/${batchId}/clocks/${clockG}/acceptance`, {});
  assert.strictEqual(doubleAccept.status, 409);

  // 完成钟 H：摆幅 179 不合格 -> 回调校 -> 摆幅 180 合格两连
  await api("POST", `/batches/${batchId}/clocks/${clockH}/initial-tests`, {
    dailyRateSeconds: 40,
    amplitude: 179
  });
  await adjustAndRetest(batchId, clockH, { rate: 12, amp: 179 });
  assert.strictEqual((await api("GET", `/batches/${batchId}`)).body.data.members.find((m) => m.clockId === clockH).stage, "adjusting");
  await adjustAndRetest(batchId, clockH, { rate: 12, amp: 190 });
  await api("POST", `/batches/${batchId}/clocks/${clockH}/retests`, {
    dailyRateSeconds: 7,
    amplitude: 200
  });
  const acceptH = await api("POST", `/batches/${batchId}/clocks/${clockH}/acceptance`, {});
  assert.strictEqual(acceptH.status, 200);
  assert.strictEqual(acceptH.body.data.batch.status, "completed");
  assert.strictEqual(acceptH.body.data.batchCompleted, true);

  // 审计：两次复测失败 + 一次提前验收拒绝 + 两次最终验收
  const audit = await auditList(`?batchId=${batchId}`);
  const failedRetests = audit.filter((item) => item.action === "retest" && item.result === "fail");
  assert.strictEqual(failedRetests.length, 3, "不合格复测(45, 321, 179)都应写 fail 审计");
  const rejectedAcceptance = audit.filter(
    (item) => item.action === "acceptance" && item.result === "rejected"
  );
  assert.ok(rejectedAcceptance.length >= 2, "提前验收与重复验收都应写 rejected 审计");
  assert.strictEqual(
    audit.filter((item) => item.action === "acceptance" && item.result === "accepted").length,
    2
  );
});

async function main() {
  global.__dbFile = await boot();
  let passed = 0;
  try {
    for (const { name, fn } of tests) {
      process.stdout.write(`• ${name} ... `);
      await fn();
      passed += 1;
      console.log("PASS");
    }
  } finally {
    await shutdown();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }
  console.log(`\n全部通过：${passed}/${tests.length}`);
}

main().catch((error) => {
  console.error("FAIL");
  console.error(error);
  process.exitCode = 1;
});
