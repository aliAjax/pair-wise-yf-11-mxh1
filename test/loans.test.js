const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = 24 * 3600 * 1000;
const fmt = (date) => date.toISOString().slice(0, 10);
const NOW = Date.now();
const START = fmt(new Date(NOW - DAY)); // 借展期覆盖今天
const END = fmt(new Date(NOW + 30 * DAY));

let child;
let dbFile;

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

function readLoansFromDisk() {
  return JSON.parse(fs.readFileSync(dbFile, "utf8")).loans || [];
}

before(async () => {
  dbFile = path.join(os.tmpdir(), `rubbing-loans-test-${process.pid}.json`);
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile },
    stdio: "ignore"
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
});

after(() => {
  child.kill();
  fs.rmSync(dbFile, { force: true });
});

test("健康检查包含借展路由", async () => {
  const { status, body } = await api("GET", "/health");
  assert.equal(status, 200);
  for (const route of ["GET /loans", "POST /loans", "POST /loans/:id/return", "POST /loans/:id/cancel"]) {
    assert.ok(body.routes.includes(route), `缺少路由 ${route}`);
  }
});

test("申请校验：缺字段/非法日期/区间倒置/空清单/拓片不存在均返回400", async () => {
  assert.equal((await api("POST", "/loans", { unit: "省博物馆" })).status, 400);
  assert.equal((await api("POST", "/loans", { unit: "省博物馆", startDate: "2026-13-01", endDate: END, rubbingIds: ["rubbing_demo"] })).status, 400);
  assert.equal((await api("POST", "/loans", { unit: "省博物馆", startDate: END, endDate: START, rubbingIds: ["rubbing_demo"] })).status, 400);
  assert.equal((await api("POST", "/loans", { unit: "省博物馆", startDate: START, endDate: END, rubbingIds: [] })).status, 400);
  const unknown = await api("POST", "/loans", { unit: "省博物馆", startDate: START, endDate: END, rubbingIds: ["rubbing_missing"] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /拓片不存在/);
  assert.equal(readLoansFromDisk().length, 0);
});

let loanId;

test("有未修复缺损时申请整单409且不落盘", async () => {
  const res = await api("POST", "/loans", { unit: "省博物馆", startDate: START, endDate: END, rubbingIds: ["rubbing_demo"] });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.conflicts.unrepaired, [
    { rubbingId: "rubbing_demo", damageIds: ["damage_demo_1", "damage_demo_2"] }
  ]);
  assert.deepEqual(res.body.conflicts.overlaps, []);
  assert.equal(readLoansFromDisk().length, 0, "409整单不得落盘");
  assert.equal((await api("GET", "/loans")).body.data.length, 0);
});

test("修复全部缺损后申请成功，拓片状态联动为on_loan", async () => {
  for (const id of ["damage_demo_1", "damage_demo_2"]) {
    assert.equal((await api("PATCH", `/damages/${id}`, { status: "repaired" })).status, 200);
  }
  const res = await api("POST", "/loans", {
    unit: "省博物馆",
    startDate: START,
    endDate: END,
    rubbingIds: ["rubbing_demo"],
    note: "清代碑刻特展"
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, "active");
  assert.equal(res.body.data.unit, "省博物馆");
  assert.equal(res.body.data.startDate, START);
  assert.equal(res.body.data.endDate, END);
  assert.deepEqual(res.body.data.rubbingIds, ["rubbing_demo"]);
  assert.equal(res.body.data.totalRubbings, 1);
  loanId = res.body.data.id;

  const rubbings = (await api("GET", "/rubbings")).body.data;
  const demo = rubbings.find((item) => item.id === "rubbing_demo");
  assert.equal(demo.loanStatus, "on_loan");
  assert.equal(demo.loanId, loanId);
  assert.ok("damageCount" in demo && "pendingDamages" in demo, "既有字段需保留");
});

test("同一拓片区间重叠的借展申请409，不重叠则201", async () => {
  const overlap = await api("POST", "/loans", { unit: "市图书馆", startDate: END, endDate: fmt(new Date(NOW + 60 * DAY)), rubbingIds: ["rubbing_demo"] });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.conflicts.overlaps.length, 1);
  assert.equal(overlap.body.conflicts.overlaps[0].loanId, loanId);

  const future = await api("POST", "/loans", {
    unit: "市图书馆",
    startDate: fmt(new Date(NOW + 31 * DAY)),
    endDate: fmt(new Date(NOW + 60 * DAY)),
    rubbingIds: ["rubbing_demo"]
  });
  assert.equal(future.status, 201);
  const demo = (await api("GET", "/rubbings")).body.data.find((item) => item.id === "rubbing_demo");
  assert.equal(demo.loanStatus, "on_loan", "当前借展优先于未来预约");
  await api("POST", `/loans/${future.body.data.id}/cancel`);
});

let reviewDamageId;

test("借展期间新增缺损进入归还复核", async () => {
  const res = await api("POST", "/rubbings/rubbing_demo/damages", {
    position: "右侧中部",
    type: "水渍",
    beforePhotoUrl: "https://example.local/loan-1.jpg"
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.returnReview, true);
  assert.equal(res.body.data.loanId, loanId);
  reviewDamageId = res.body.data.id;

  const damages = (await api("GET", "/rubbings/rubbing_demo/damages")).body.data;
  assert.equal(damages.find((item) => item.id === reviewDamageId).returnReview, true);
});

test("归还时仍有未修复缺损则拒绝并保持借出", async () => {
  const res = await api("POST", `/loans/${loanId}/return`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /保持借出/);
  assert.deepEqual(res.body.unrepairedDamages.map((item) => item.id), [reviewDamageId]);
  assert.equal(res.body.unrepairedDamages[0].returnReview, true);

  const loan = (await api("GET", `/loans/${loanId}`)).body.data;
  assert.equal(loan.status, "active", "拒绝归还后保持借出");
  assert.equal(loan.returnedAt, null);
});

test("复核缺损修复后归还成功，占用释放", async () => {
  assert.equal((await api("PATCH", `/damages/${reviewDamageId}`, { status: "repaired" })).status, 200);
  const res = await api("POST", `/loans/${loanId}/return`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, "returned");
  assert.ok(res.body.data.returnedAt);

  const demo = (await api("GET", "/rubbings")).body.data.find((item) => item.id === "rubbing_demo");
  assert.equal(demo.loanStatus, "available");

  const again = await api("POST", "/loans", { unit: "大学图书馆", startDate: START, endDate: END, rubbingIds: ["rubbing_demo"] });
  assert.equal(again.status, 201, "已归还的区间可再次借展");
  await api("POST", `/loans/${again.body.data.id}/cancel`);
});

let cancelLoanId;

test("取消释放占用，且仅借出中可取消/归还", async () => {
  const res = await api("POST", "/loans", { unit: "私人藏家", startDate: START, endDate: END, rubbingIds: ["rubbing_demo"] });
  assert.equal(res.status, 201);
  cancelLoanId = res.body.data.id;

  const cancelled = await api("POST", `/loans/${cancelLoanId}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.status, "cancelled");
  assert.ok(cancelled.body.data.cancelledAt);

  const reapply = await api("POST", "/loans", { unit: "私人藏家", startDate: START, endDate: END, rubbingIds: ["rubbing_demo"] });
  assert.equal(reapply.status, 201, "取消后区间不再占用");
  await api("POST", `/loans/${reapply.body.data.id}/cancel`);

  assert.equal((await api("POST", `/loans/${cancelLoanId}/cancel`)).status, 409, "重复取消拒绝");
  assert.equal((await api("POST", `/loans/${cancelLoanId}/return`)).status, 409, "已取消不可归还");
  assert.equal((await api("POST", `/loans/${loanId}/return`)).status, 409, "已归还不可重复归还");
  assert.equal((await api("GET", "/loans/loan_missing")).status, 404);
  assert.equal((await api("POST", "/loans/loan_missing/return")).status, 404);
});

test("非借展期新增缺损不进入归还复核，既有批次流程不受影响", async () => {
  const created = await api("POST", "/rubbings/rubbing_demo/damages", {
    position: "左下角",
    type: "折痕",
    beforePhotoUrl: "https://example.local/normal-1.jpg"
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.returnReview, false);
  assert.equal(created.body.data.loanId, null);

  const batch = await api("POST", "/batches", { name: "回归测试批", damageIds: [created.body.data.id] });
  assert.equal(batch.status, 201);
  const done = await api("POST", `/batches/${batch.body.data.id}/complete`, {});
  assert.equal(done.status, 200);
  assert.equal(done.body.data.repaired, 1);
});
