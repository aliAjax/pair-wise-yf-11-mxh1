# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次和借展单。借展的存储、冲突校验与状态联动独立在 `loans.js` 业务模块中。

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
- `GET /loans?status=`
- `POST /loans`
- `GET /loans/:id`
- `POST /loans/:id/return`
- `POST /loans/:id/cancel`

## 借展闭环

- `POST /loans` 登记借展单位、起止时间和拓片清单；任一份拓片有未修复缺损，或与未结束借展区间重叠，整单返回 `409` 且不落盘。
- 借展期间新增的缺损自动进入归还复核（借展单详情的 `returnReview` 中标记 `duringLoan`）。
- `POST /loans/:id/return` 归还复核：仍有未修复缺损则返回 `409` 并保持借出状态，全部修复后归还成功。
- `POST /loans/:id/cancel` 取消借展并释放拓片占用。
- `GET /rubbings` 新增 `onLoan` / `activeLoanId` 联动字段，其余响应字段不变。

```bash
curl -X POST http://127.0.0.1:3020/loans \
  -H 'Content-Type: application/json' \
  -d '{"organization":"省博物馆","startDate":"2026-10-01","endDate":"2026-11-01","rubbingIds":["rubbing_demo"]}'
curl -X POST http://127.0.0.1:3020/loans/loan_xxx/return
```

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
```
