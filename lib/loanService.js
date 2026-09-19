// 借展闭环编排：申请登记 -> 冲突校验 -> 借出 -> 归还复核/取消
// 存储、冲突校验、状态联动分别委托 loanStore / loanConflicts / loanStatus
const store = require("./loanStore");
const conflicts = require("./loanConflicts");
const status = require("./loanStatus");

function httpError(statusCode, message, details) {
  const error = new Error(message);
  error.status = statusCode;
  error.details = details;
  return error;
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateApplication(db, body) {
  const missing = ["unit", "startDate", "endDate", "rubbingIds"].filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
  if (!Array.isArray(body.rubbingIds) || body.rubbingIds.length === 0) throw httpError(400, "rubbingIds必须是非空数组");
  for (const field of ["startDate", "endDate"]) {
    if (!isValidDate(body[field])) throw httpError(400, `${field}格式必须为YYYY-MM-DD`);
  }
  if (body.startDate > body.endDate) throw httpError(400, "startDate不能晚于endDate");
  const rubbingIds = [...new Set(body.rubbingIds)];
  const unknown = rubbingIds.filter((id) => !db.rubbings.find((rubbing) => rubbing.id === id));
  if (unknown.length) throw httpError(400, `拓片不存在：${unknown.join(", ")}`);
  return { rubbingIds };
}

// 申请借展：登记单位、起止时间、拓片清单；任一冲突整单拒绝（由调用方保证不落盘）
function applyLoan(db, body, makeId) {
  const { rubbingIds } = validateApplication(db, body);
  const conflict = conflicts.checkLoanConflicts(db, { rubbingIds, startDate: body.startDate, endDate: body.endDate });
  if (conflict.hasConflict) {
    throw httpError(409, "存在未修复缺损或借展区间冲突，整单已拒绝", {
      conflicts: { unrepaired: conflict.unrepaired, overlaps: conflict.overlaps }
    });
  }
  const loan = {
    id: makeId("loan"),
    unit: body.unit,
    startDate: body.startDate,
    endDate: body.endDate,
    rubbingIds,
    status: "active",
    note: body.note || "",
    createdAt: new Date().toISOString(),
    returnedAt: null,
    cancelledAt: null
  };
  return store.insertLoan(db, loan);
}

// 归还复核：仍有未修复缺损则拒绝并保持借出
function returnLoan(db, id) {
  const loan = store.findLoan(db, id);
  if (!loan) throw httpError(404, "借展单不存在");
  if (loan.status !== "active") throw httpError(409, "仅借出中的借展单可归还");
  const blocking = conflicts.unrepairedDamages(db, loan.rubbingIds);
  if (blocking.length) {
    throw httpError(409, "仍存在未修复缺损，拒绝归还，借展单保持借出", {
      unrepairedDamages: blocking.map((damage) => ({
        id: damage.id,
        rubbingId: damage.rubbingId,
        position: damage.position,
        type: damage.type,
        status: damage.status,
        returnReview: damage.returnReview === true
      }))
    });
  }
  loan.status = "returned";
  loan.returnedAt = new Date().toISOString();
  return store.saveLoan(db, loan);
}

// 取消借展：释放拓片占用
function cancelLoan(db, id) {
  const loan = store.findLoan(db, id);
  if (!loan) throw httpError(404, "借展单不存在");
  if (loan.status !== "active") throw httpError(409, "仅借出中的借展单可取消");
  loan.status = "cancelled";
  loan.cancelledAt = new Date().toISOString();
  return store.saveLoan(db, loan);
}

function enrichLoan(db, loan) {
  const rubbings = loan.rubbingIds
    .map((id) => db.rubbings.find((rubbing) => rubbing.id === id))
    .filter(Boolean)
    .map((rubbing) => status.decorateRubbing(db, rubbing));
  return {
    ...loan,
    rubbings,
    totalRubbings: rubbings.length,
    unrepairedDamages: conflicts.unrepairedDamages(db, loan.rubbingIds)
  };
}

module.exports = { applyLoan, returnLoan, cancelLoan, enrichLoan };
