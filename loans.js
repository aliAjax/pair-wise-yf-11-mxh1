// 借展业务模块：存储、冲突校验、状态联动
// 借展单状态机：active(借出中) -> returned(已归还) / cancelled(已取消)
// 只有 active 状态的借展单占用拓片，归还或取消后释放占用。

const LOAN_STATUS = {
  ACTIVE: "active",
  RETURNED: "returned",
  CANCELLED: "cancelled"
};

// ---- 存储 ----

// 兼容旧库：db.json 中可能还没有 loans 数组
function ensureLoanStore(db) {
  if (!Array.isArray(db.loans)) db.loans = [];
  return db.loans;
}

function listLoans(db, { status } = {}) {
  return ensureLoanStore(db).filter((loan) => !status || loan.status === status);
}

function findLoan(db, loanId) {
  const loan = ensureLoanStore(db).find((item) => item.id === loanId);
  if (!loan) {
    const error = new Error("借展单不存在");
    error.status = 404;
    throw error;
  }
  return loan;
}

function createLoan(db, payload, makeId) {
  const loan = {
    id: makeId("loan"),
    organization: payload.organization,
    startDate: payload.startDate,
    endDate: payload.endDate,
    rubbingIds: payload.rubbingIds,
    status: LOAN_STATUS.ACTIVE,
    note: payload.note || "",
    createdAt: new Date().toISOString(),
    returnedAt: null,
    cancelledAt: null
  };
  ensureLoanStore(db).push(loan);
  return loan;
}

// ---- 校验 ----

function toTime(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function unrepairedDamages(db, rubbingIds) {
  return db.damages.filter(
    (damage) => rubbingIds.includes(damage.rubbingId) && damage.status !== "repaired"
  );
}

function validateLoanPayload(db, body) {
  const missing = ["organization", "startDate", "endDate", "rubbingIds"].filter(
    (field) => body[field] === undefined || body[field] === ""
  );
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(body.rubbingIds) || body.rubbingIds.length === 0) {
    const error = new Error("rubbingIds必须是非空数组");
    error.status = 400;
    throw error;
  }
  const invalid = body.rubbingIds.filter((id) => !db.rubbings.find((rubbing) => rubbing.id === id));
  if (invalid.length) {
    const error = new Error(`拓片不存在：${invalid.join(", ")}`);
    error.status = 400;
    throw error;
  }
  const start = toTime(body.startDate);
  const end = toTime(body.endDate);
  if (start === null || end === null) {
    const error = new Error("startDate/endDate必须是合法日期");
    error.status = 400;
    throw error;
  }
  if (start > end) {
    const error = new Error("startDate不能晚于endDate");
    error.status = 400;
    throw error;
  }
  return {
    organization: body.organization,
    startDate: new Date(start).toISOString(),
    endDate: new Date(end).toISOString(),
    rubbingIds: [...new Set(body.rubbingIds)],
    note: body.note || ""
  };
}

// 申请冲突校验：任一拓片有未修复缺损，或与未结束借展区间重叠。
// 返回冲突列表，调用方据此整单 409 且不落盘。
function findLoanConflicts(db, payload) {
  const conflicts = [];
  const unrepaired = unrepairedDamages(db, payload.rubbingIds);
  if (unrepaired.length) {
    conflicts.push({
      reason: "unrepaired_damages",
      message: "清单内拓片存在未修复缺损",
      damages: unrepaired.map((damage) => ({
        id: damage.id,
        rubbingId: damage.rubbingId,
        position: damage.position,
        type: damage.type,
        status: damage.status
      }))
    });
  }
  const start = toTime(payload.startDate);
  const end = toTime(payload.endDate);
  const overlapping = ensureLoanStore(db).filter(
    (loan) =>
      loan.status === LOAN_STATUS.ACTIVE &&
      loan.rubbingIds.some((id) => payload.rubbingIds.includes(id)) &&
      intervalsOverlap(start, end, toTime(loan.startDate), toTime(loan.endDate))
  );
  if (overlapping.length) {
    conflicts.push({
      reason: "loan_overlap",
      message: "清单内拓片与未结束借展区间重叠",
      loans: overlapping.map((loan) => ({
        id: loan.id,
        organization: loan.organization,
        startDate: loan.startDate,
        endDate: loan.endDate,
        rubbingIds: loan.rubbingIds.filter((id) => payload.rubbingIds.includes(id))
      }))
    });
  }
  return conflicts;
}

// ---- 状态联动 ----

// 拓片当前是否处于借出中（供 /rubbings 等既有接口联动展示）
function activeLoanForRubbing(db, rubbingId) {
  return (
    ensureLoanStore(db).find(
      (loan) => loan.status === LOAN_STATUS.ACTIVE && loan.rubbingIds.includes(rubbingId)
    ) || null
  );
}

function assertActive(loan) {
  if (loan.status !== LOAN_STATUS.ACTIVE) {
    const error = new Error("借展单不在借出状态");
    error.status = 409;
    throw error;
  }
}

// 归还复核：汇总清单内全部未修复缺损，借展期间新增的缺损一并纳入
function reviewReturn(db, loan) {
  assertActive(loan);
  const unrepaired = unrepairedDamages(db, loan.rubbingIds).map((damage) => ({
    id: damage.id,
    rubbingId: damage.rubbingId,
    position: damage.position,
    type: damage.type,
    status: damage.status,
    duringLoan: toTime(damage.createdAt) >= toTime(loan.createdAt)
  }));
  return { ok: unrepaired.length === 0, unrepaired };
}

function completeReturn(db, loan) {
  assertActive(loan);
  loan.status = LOAN_STATUS.RETURNED;
  loan.returnedAt = new Date().toISOString();
  return loan;
}

// 取消即释放占用：后续冲突校验不再考虑该单
function cancelLoan(db, loan) {
  assertActive(loan);
  loan.status = LOAN_STATUS.CANCELLED;
  loan.cancelledAt = new Date().toISOString();
  return loan;
}

// 借展单视图：附带拓片明细与归还复核信息
function enrichLoan(db, loan) {
  const rubbings = loan.rubbingIds
    .map((id) => db.rubbings.find((rubbing) => rubbing.id === id))
    .filter(Boolean);
  const unrepaired = unrepairedDamages(db, loan.rubbingIds).map((damage) => ({
    ...damage,
    duringLoan: toTime(damage.createdAt) >= toTime(loan.createdAt)
  }));
  return {
    ...loan,
    rubbings,
    returnReview: {
      unrepairedCount: unrepaired.length,
      damages: unrepaired
    }
  };
}

module.exports = {
  LOAN_STATUS,
  ensureLoanStore,
  listLoans,
  findLoan,
  createLoan,
  validateLoanPayload,
  findLoanConflicts,
  activeLoanForRubbing,
  reviewReturn,
  completeReturn,
  cancelLoan,
  enrichLoan
};
