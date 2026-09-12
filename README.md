# 机械钟表擒纵调校 / 调校批次管理 API

纯后端零依赖 Node 服务（Node >= 18），使用 JSON 文件持久化（原子写 + 写串行化），
保存钟表档案、调校批次、初测、调校、复测与审计记录。服务重启后数据仍可查询，
旧版 `data/db.json` 首次启动自动迁移。

## 启动与测试

```bash
PORT=3021 node server.js        # 或 npm start
node test/batch.test.js         # 或 npm test（自动使用临时库，不影响 data/db.json）
```

可用环境变量：`PORT`（默认 3021）、`DB_FILE`（默认 `data/db.json`）。

## 工作流

技师先创建批次，把多只钟表挂到同一批次。批次内每只钟表按阶段推进：

```
initial_test(待初测) -> adjusting(待调校) -> retesting(待复测) -> accepted(已验收)
```

- **初测**：记录走时误差与摆幅，进入调校阶段。
- **调校**：记录调校方向与幅度，进入复测阶段。
- **复测**：走时误差进入该钟表目标范围（`|dailyRateSeconds| <= targetDailyRateSeconds`）
  且摆幅在 **180°～320°**（含边界）记为合格。合格保持复测阶段并累计连续合格次数；
  **不合格连续次数清零并强制回到调校阶段**，必须重新调校才能再次复测。
- **验收**：最近两次复测必须连续合格（误差达标且摆幅合法）才能验收；
  验收失败返回 `422/409` 且**仍写审计**。重复验收报 `409`。
- 批次内所有钟表验收后，批次自动置为 `completed`。

约束：

- 同一钟表不能同时进入两个未完成批次（返回 `409`）；批次完成后可再挂新批次。
- 创建批次按 `code` 幂等（也支持 `idempotencyKey`），重复提交返回既有记录（`deduplicated: true`，HTTP 200），不生成新记录。
- 向同一批次重复挂同一只钟幂等，不新增成员、不写审计。
- 初测、调校、复测、验收（含被拒）、挂钟、批次创建/完成全部写 `GET /audit` 可查的审计记录。

## 主要接口

原有接口（保留向后兼容）：

- `GET /health`
- `GET /clocks` / `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments` / `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=` / `GET /retests?clockId=&qualified=`

批次接口：

- `POST /batches` — `{code, technician?, note?, idempotencyKey?}`
- `GET /batches?status=open|completed` / `GET /batches/:id`
- `POST /batches/:id/clocks` — `{clockId}` 或 `{clockIds: [...]}`
- `POST /batches/:id/clocks/:clockId/initial-tests` — `{dailyRateSeconds, amplitude, note?}`
- `POST /batches/:id/clocks/:clockId/adjustments` — `{currentDailyRateSeconds, direction, amount, note?}`
- `POST /batches/:id/clocks/:clockId/retests` — `{dailyRateSeconds, amplitude, note?}`
- `POST /batches/:id/clocks/:clockId/acceptance`
- `GET /audit?batchId=&clockId=&action=&result=`

## 闭环示例

```bash
# 建批次并挂两只钟
BID=$(curl -s -X POST http://127.0.0.1:3021/batches \
  -H 'Content-Type: application/json' -d '{"code":"BATCH-2026-09-01","technician":"王技师"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.id))")

curl -X POST http://127.0.0.1:3021/batches/$BID/clocks \
  -H 'Content-Type: application/json' -d '{"clockIds":["clock_demo"]}'

# 初测 -> 调校 -> 连续两次复测合格 -> 验收
curl -X POST http://127.0.0.1:3021/batches/$BID/clocks/clock_demo/initial-tests \
  -H 'Content-Type: application/json' -d '{"dailyRateSeconds":68,"amplitude":245}'
curl -X POST http://127.0.0.1:3021/batches/$BID/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":68,"direction":"慢针方向","amount":"快慢针向慢侧0.3格"}'
curl -X POST http://127.0.0.1:3021/batches/$BID/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' -d '{"dailyRateSeconds":12,"amplitude":250}'
curl -X POST http://127.0.0.1:3021/batches/$BID/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' -d '{"dailyRateSeconds":8,"amplitude":246}'
curl -X POST http://127.0.0.1:3021/batches/$BID/clocks/clock_demo/acceptance

# 审计轨迹
curl "http://127.0.0.1:3021/audit?batchId=$BID"
```
