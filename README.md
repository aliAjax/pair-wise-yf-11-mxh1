# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次和借展单。

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`
- `GET /loans`
- `POST /loans`
- `GET /loans/:id`
- `POST /loans/:id/return`
- `POST /loans/:id/cancel`

## 借展闭环

- **申请**：`POST /loans` 登记 `unit`（借展单位）、`startDate`/`endDate`（YYYY-MM-DD）、`rubbingIds`（拓片清单）。
- **整单冲突**：任一拓片存在未修复缺损，或与未结束（active）借展的区间重叠，整单返回 `409` 且不落盘，响应体 `conflicts` 字段给出明细。
- **状态联动**：`GET /rubbings` 在既有字段上追加 `loanStatus`（`available`/`reserved`/`on_loan`）与 `loanId`。
- **归还复核**：借展期内新增的缺损自动标记 `returnReview: true`；`POST /loans/:id/return` 时若仍有未修复缺损则返回 `409` 并保持借出，修复后方可归还。
- **取消**：`POST /loans/:id/cancel` 仅对借出中的借展单有效，取消后区间占用立即释放。

## 模块结构

- `server.js` — 路由与既有修补业务
- `lib/db.js` — JSON 文件持久化（含旧数据迁移）
- `lib/loanStore.js` — 借展存储
- `lib/loanConflicts.js` — 冲突校验（未修复缺损 + 区间重叠）
- `lib/loanStatus.js` — 状态联动（占用状态推导、归还复核标记）
- `lib/loanService.js` — 借展闭环编排（申请/归还/取消）

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 借展申请 -> 归还复核 -> 归还/取消
curl -X POST http://127.0.0.1:3020/loans \
  -H 'Content-Type: application/json' \
  -d '{"unit":"省博物馆","startDate":"2026-10-01","endDate":"2026-11-01","rubbingIds":["rubbing_demo"]}'
curl -X POST http://127.0.0.1:3020/loans/<loanId>/return
```

## 测试

```bash
node --test test/
```
