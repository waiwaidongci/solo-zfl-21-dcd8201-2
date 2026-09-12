const http = require("http");
const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "data", "db.json");

const MIN_AMPLITUDE = 180;
const MAX_AMPLITUDE = 320;
// 成员阶段：initial_test(待初测) -> adjusting(待调校) -> retesting(待复测) -> accepted(已验收)
const STAGES = ["initial_test", "adjusting", "retesting", "accepted"];

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      batchId: null,
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      batchId: null,
      adjustmentId: "adjustment_demo",
      testedAt: "2026-06-16T00:00:00.000Z",
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      rateInRange: false,
      amplitudeInRange: true,
      note: "仍偏快，振幅尚可"
    }
  ],
  initialTests: [],
  batches: [],
  audit: []
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "POST /batches",
  "GET /batches",
  "GET /batches/:id",
  "POST /batches/:id/clocks",
  "POST /batches/:id/clocks/:clockId/initial-tests",
  "POST /batches/:id/clocks/:clockId/adjustments",
  "POST /batches/:id/clocks/:clockId/retests",
  "POST /batches/:id/clocks/:clockId/acceptance",
  "GET /audit"
];

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// 所有写操作串行化，避免并发请求“读-改-写”互相覆盖
let writeChain = Promise.resolve();
function withWriteLock(task) {
  const run = writeChain.then(() => task());
  writeChain = run.catch(() => {});
  return run;
}

async function mutate(task) {
  return withWriteLock(async () => {
    const db = await loadDb();
    const result = await task(db);
    await persist(db);
    return result;
  });
}

function migrate(db) {
  let changed = false;
  for (const key of Object.keys(initialData)) {
    if (!Array.isArray(db[key])) {
      db[key] = [];
      changed = true;
    }
  }
  return changed;
}

async function initDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let db;
  try {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return;
  }
  if (migrate(db)) await persist(db);
}

async function loadDb() {
  let db;
  try {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    db = JSON.parse(JSON.stringify(initialData));
  }
  migrate(db);
  return db;
}

// 同目录临时文件 + rename，保证落盘原子性（重启/并发下不会读到半个文件）
async function persist(db) {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, DB_FILE);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "请求体必须是合法JSON");
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
}

function toNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw httpError(400, `字段 ${field} 必须是数字`);
  return n;
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw httpError(404, "钟表不存在");
  return clock;
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) throw httpError(404, "批次不存在");
  return batch;
}

function findMember(batch, clockId) {
  const member = batch.members.find((item) => item.clockId === clockId);
  if (!member) throw httpError(404, "该钟表未挂入此批次");
  return member;
}

function assertStage(member, expected, message) {
  const ok = Array.isArray(expected) ? expected.includes(member.stage) : member.stage === expected;
  if (!ok) throw httpError(409, message || `当前阶段(${member.stage})不允许该操作`);
}

function latestRetest(db, clockId, batchId = null) {
  return db.retests
    .filter((item) => item.clockId === clockId && (batchId === null || item.batchId === batchId))
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId, batchId = null) {
  return db.adjustments
    .filter((item) => item.clockId === clockId && (batchId === null || item.batchId === batchId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false
  };
}

// 验收判据：走时误差进入该钟表目标范围，且摆幅在 [180, 320] 度
function evaluateRetest(clock, dailyRateSeconds, amplitude) {
  const rateInRange = Math.abs(dailyRateSeconds) <= Number(clock.targetDailyRateSeconds);
  const amplitudeInRange = amplitude >= MIN_AMPLITUDE && amplitude <= MAX_AMPLITUDE;
  return { rateInRange, amplitudeInRange, qualified: rateInRange && amplitudeInRange };
}

function writeAudit(db, { batchId = null, clockId = null, action, result, detail = {} }) {
  const entry = {
    id: makeId("audit"),
    at: new Date().toISOString(),
    batchId,
    clockId,
    action,
    result,
    detail
  };
  db.audit.push(entry);
  return entry;
}

function batchDetail(db, batch) {
  return {
    ...batch,
    members: batch.members.map((member) => {
      const clock = db.clocks.find((item) => item.id === member.clockId);
      return {
        ...member,
        clock: clock ? clockSummary(db, clock) : null,
        latestAdjustment: latestAdjustment(db, member.clockId, batch.id),
        latestRetest: latestRetest(db, member.clockId, batch.id)
      };
    })
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  // ---------- 批次 ----------

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["code"]);
    const out = await mutate((db) => {
      // 幂等：相同批次编号（或幂等键）重复提交直接返回既有批次，不生成新记录
      const existing = db.batches.find(
        (item) => item.code === body.code || (body.idempotencyKey && item.idempotencyKey === body.idempotencyKey)
      );
      if (existing) {
        return { status: 200, deduplicated: true, data: batchDetail(db, existing) };
      }
      const now = new Date().toISOString();
      const batch = {
        id: makeId("batch"),
        code: body.code,
        technician: body.technician || "",
        note: body.note || "",
        idempotencyKey: body.idempotencyKey || null,
        status: "open",
        members: [],
        createdAt: now,
        finishedAt: null
      };
      db.batches.push(batch);
      writeAudit(db, {
        batchId: batch.id,
        action: "batch.create",
        result: "success",
        detail: { code: batch.code, technician: batch.technician }
      });
      return { status: 201, deduplicated: false, data: batchDetail(db, batch) };
    });
    return send(res, out.status, { data: out.data, deduplicated: out.deduplicated });
  }

  if (req.method === "GET" && pathname === "/batches") {
    const db = await loadDb();
    const status = url.searchParams.get("status");
    let list = [...db.batches].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (status) list = list.filter((item) => item.status === status);
    return send(res, 200, { data: list.map((item) => batchDetail(db, item)) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const db = await loadDb();
    return send(res, 200, { data: batchDetail(db, findBatch(db, batchMatch[1])) });
  }

  const attachMatch = pathname.match(/^\/batches\/([^/]+)\/clocks$/);
  if (attachMatch && req.method === "POST") {
    const body = await parseBody(req);
    const rawIds = body.clockIds || (body.clockId ? [body.clockId] : []);
    const clockIds = [...new Set(rawIds.filter(Boolean))];
    if (!clockIds.length) throw httpError(400, "缺少字段：clockId 或 clockIds");
    const out = await mutate((db) => {
      const batch = findBatch(db, attachMatch[1]);
      if (batch.status !== "open") throw httpError(409, "批次已完成，不能再挂入钟表");
      const attached = [];
      const existed = [];
      for (const clockId of clockIds) {
        findClock(db, clockId);
        if (batch.members.some((member) => member.clockId === clockId)) {
          existed.push(clockId); // 幂等：已挂入本批次，不重复建记录
          continue;
        }
        // 同一钟表不能同时进入两个未完成批次
        const blocker = db.batches.find(
          (item) =>
            item.id !== batch.id &&
            item.status === "open" &&
            item.members.some((member) => member.clockId === clockId)
        );
        if (blocker) throw httpError(409, `钟表已在未完成批次 ${blocker.code} 中，不能重复挂钟`);
        const member = {
          clockId,
          stage: "initial_test",
          passStreak: 0,
          addedAt: new Date().toISOString(),
          acceptedAt: null
        };
        batch.members.push(member);
        attached.push(clockId);
        writeAudit(db, {
          batchId: batch.id,
          clockId,
          action: "clock.attach",
          result: "success",
          detail: { stage: member.stage }
        });
      }
      return {
        status: 201,
        deduplicated: existed.length > 0,
        data: batchDetail(db, batch),
        attached,
        existed
      };
    });
    return send(res, out.status, {
      data: out.data,
      attached: out.attached,
      existed: out.existed,
      deduplicated: out.deduplicated
    });
  }

  const memberActionMatch = pathname.match(
    /^\/batches\/([^/]+)\/clocks\/([^/]+)\/(initial-tests|adjustments|retests|acceptance)$/
  );
  if (memberActionMatch && req.method === "POST") {
    const [, batchId, clockId, actionName] = memberActionMatch;
    const body = await parseBody(req);
    const out = await mutate((db) => {
      const batch = findBatch(db, batchId);
      if (batch.status !== "open") throw httpError(409, "批次已完成");
      const clock = findClock(db, clockId);
      const member = findMember(batch, clockId);
      const now = new Date().toISOString();

      if (actionName === "initial-tests") {
        required(body, ["dailyRateSeconds", "amplitude"]);
        assertStage(member, "initial_test", "已做过初测，不能重复初测");
        const dailyRateSeconds = toNumber(body.dailyRateSeconds, "dailyRateSeconds");
        const amplitude = toNumber(body.amplitude, "amplitude");
        const initialTest = {
          id: makeId("initial_test"),
          batchId: batch.id,
          clockId: clock.id,
          testedAt: body.testedAt || now,
          dailyRateSeconds,
          amplitude,
          note: body.note || ""
        };
        db.initialTests.push(initialTest);
        member.stage = "adjusting";
        writeAudit(db, {
          batchId: batch.id,
          clockId: clock.id,
          action: "initial_test",
          result: "success",
          detail: {
            initialTestId: initialTest.id,
            dailyRateSeconds,
            amplitude
          }
        });
        return { status: 201, data: { initialTest, member } };
      }

      if (actionName === "adjustments") {
        required(body, ["currentDailyRateSeconds", "direction", "amount"]);
        assertStage(member, "adjusting", "当前不在调校阶段（复测不合格需重新调校后才能继续）");
        const adjustment = {
          id: makeId("adjustment"),
          batchId: batch.id,
          clockId: clock.id,
          currentDailyRateSeconds: toNumber(body.currentDailyRateSeconds, "currentDailyRateSeconds"),
          direction: body.direction,
          amount: body.amount,
          note: body.note || "",
          createdAt: now
        };
        db.adjustments.push(adjustment);
        member.stage = "retesting";
        writeAudit(db, {
          batchId: batch.id,
          clockId: clock.id,
          action: "adjustment",
          result: "success",
          detail: {
            adjustmentId: adjustment.id,
            currentDailyRateSeconds: adjustment.currentDailyRateSeconds,
            direction: adjustment.direction,
            amount: adjustment.amount
          }
        });
        return { status: 201, data: { adjustment, member } };
      }

      if (actionName === "retests") {
        required(body, ["dailyRateSeconds", "amplitude"]);
        assertStage(member, "retesting", "必须先完成调校才能复测");
        const dailyRateSeconds = toNumber(body.dailyRateSeconds, "dailyRateSeconds");
        const amplitude = toNumber(body.amplitude, "amplitude");
        const verdict = evaluateRetest(clock, dailyRateSeconds, amplitude);
        const adjustment = latestAdjustment(db, clock.id, batch.id);
        const retest = {
          id: makeId("retest"),
          batchId: batch.id,
          clockId: clock.id,
          adjustmentId: adjustment ? adjustment.id : null,
          testedAt: body.testedAt || now,
          dailyRateSeconds,
          amplitude,
          qualified: verdict.qualified,
          rateInRange: verdict.rateInRange,
          amplitudeInRange: verdict.amplitudeInRange,
          note: body.note || ""
        };
        db.retests.push(retest);
        if (verdict.qualified) {
          member.passStreak += 1; // 保持在复测阶段，等待下一次连续复测或验收
        } else {
          member.passStreak = 0;
          member.stage = "adjusting"; // 不合格必须回到调校
        }
        writeAudit(db, {
          batchId: batch.id,
          clockId: clock.id,
          action: "retest",
          result: verdict.qualified ? "pass" : "fail",
          detail: {
            retestId: retest.id,
            dailyRateSeconds,
            amplitude,
            rateInRange: verdict.rateInRange,
            amplitudeInRange: verdict.amplitudeInRange,
            qualified: verdict.qualified,
            nextStage: member.stage,
            passStreak: member.passStreak
          }
        });
        return { status: 201, data: { retest, member } };
      }

      // acceptance：验收，无论通过与否都写审计
      // 注意：拒绝结果不能用抛错中断，否则上面已写入的拒绝审计不会落盘
      const evidence = db.retests
        .filter((item) => item.batchId === batch.id && item.clockId === clock.id)
        .sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt))
        .slice(-2);
      let accepted = false;
      let reason = null;
      if (member.stage === "accepted") {
        reason = "already_accepted";
      } else if (member.stage !== "retesting") {
        reason = "not_in_retest_stage";
      } else if (member.passStreak < 2 || evidence.length < 2) {
        reason = "insufficient_consecutive_passes";
      } else if (!evidence.every((item) => item.qualified)) {
        reason = "latest_two_retests_not_qualified";
      } else {
        accepted = true;
      }

      if (!accepted) {
        const auditEntry = writeAudit(db, {
          batchId: batch.id,
          clockId: clock.id,
          action: "acceptance",
          result: "rejected",
          detail: {
            reason,
            stage: member.stage,
            passStreak: member.passStreak,
            evidence: evidence.map((item) => ({
              retestId: item.id,
              dailyRateSeconds: item.dailyRateSeconds,
              amplitude: item.amplitude,
              qualified: item.qualified
            }))
          }
        });
        const status = reason === "already_accepted" || reason === "not_in_retest_stage" ? 409 : 422;
        return { rejected: { status, message: `验收不通过：${reason}`, audit: auditEntry } };
      }

      member.stage = "accepted";
      member.acceptedAt = now;
      writeAudit(db, {
        batchId: batch.id,
        clockId: clock.id,
        action: "acceptance",
        result: "accepted",
        detail: {
          acceptedAt: now,
          evidence: evidence.map((item) => ({
            retestId: item.id,
            dailyRateSeconds: item.dailyRateSeconds,
            amplitude: item.amplitude,
            qualified: item.qualified
          }))
        }
      });

      // 批次内所有钟表验收后，批次自动完成
      let batchCompleted = false;
      if (batch.members.length > 0 && batch.members.every((item) => item.stage === "accepted")) {
        batch.status = "completed";
        batch.finishedAt = now;
        batchCompleted = true;
        writeAudit(db, {
          batchId: batch.id,
          action: "batch.complete",
          result: "success",
          detail: { finishedAt: now, memberCount: batch.members.length }
        });
      }
      return { status: 200, data: { member, batch: batchDetail(db, batch), batchCompleted } };
    });
    if (out.rejected) {
      return send(res, out.rejected.status, {
        error: out.rejected.message,
        audit: out.rejected.audit
      });
    }
    return send(res, out.status, { data: out.data });
  }

  if (req.method === "GET" && pathname === "/audit") {
    const db = await loadDb();
    const batchId = url.searchParams.get("batchId");
    const clockId = url.searchParams.get("clockId");
    const action = url.searchParams.get("action");
    const result = url.searchParams.get("result");
    const data = db.audit
      .filter((item) => {
        return (
          (!batchId || item.batchId === batchId) &&
          (!clockId || item.clockId === clockId) &&
          (!action || item.action === action) &&
          (!result || item.result === result)
        );
      })
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    return send(res, 200, { data });
  }

  // ---------- 原有单钟接口（保留向后兼容） ----------

  if (req.method === "GET" && pathname === "/clocks") {
    const db = await loadDb();
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const out = await mutate((db) => {
      const clock = {
        id: makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.clocks.push(clock);
      return clockSummary(db, clock);
    });
    return send(res, 201, { data: out });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const db = await loadDb();
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const db = await loadDb();
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    const initialTests = db.initialTests.filter((item) => item.clockId === clock.id);
    return send(res, 200, {
      data: { clock, initialTests, adjustments, retests, latestRetest: latestRetest(db, clock.id) }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clockId = adjustmentMatch[1];
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const out = await mutate((db) => {
      findClock(db, clockId);
      const adjustment = {
        id: makeId("adjustment"),
        clockId,
        batchId: null,
        currentDailyRateSeconds: toNumber(body.currentDailyRateSeconds, "currentDailyRateSeconds"),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.adjustments.push(adjustment);
      return adjustment;
    });
    return send(res, 201, { data: out });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clockId = retestMatch[1];
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const out = await mutate((db) => {
      const clock = findClock(db, clockId);
      const dailyRateSeconds = toNumber(body.dailyRateSeconds, "dailyRateSeconds");
      const amplitude = toNumber(body.amplitude, "amplitude");
      const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
      const qualified = body.qualified !== undefined
        ? Boolean(body.qualified)
        : Math.abs(dailyRateSeconds) <= Number(clock.targetDailyRateSeconds);
      const retest = {
        id: makeId("retest"),
        clockId,
        batchId: null,
        adjustmentId,
        testedAt: body.testedAt || new Date().toISOString(),
        dailyRateSeconds,
        amplitude,
        qualified,
        rateInRange: Math.abs(dailyRateSeconds) <= Number(clock.targetDailyRateSeconds),
        amplitudeInRange: amplitude >= MIN_AMPLITUDE && amplitude <= MAX_AMPLITUDE,
        note: body.note || ""
      };
      db.retests.push(retest);
      return { retest, clock: clockSummary(db, clock) };
    });
    return send(res, 201, { data: out.retest, clock: out.clock });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    const db = await loadDb();
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const db = await loadDb();
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const db = await loadDb();
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, { error: error.message || "服务器错误" })
  );
});

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
      console.log(`DB file: ${DB_FILE}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });

module.exports = { server, evaluateRetest, MIN_AMPLITUDE, MAX_AMPLITUDE };
