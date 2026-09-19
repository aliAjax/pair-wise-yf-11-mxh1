// 借展状态联动模块：由借展单推导拓片占用状态，并标记借展期新增缺损进入归还复核
const { listLoans } = require("./loanStore");

const LOAN_STATUS = { AVAILABLE: "available", RESERVED: "reserved", ON_LOAN: "on_loan" };

function today() {
  return new Date().toISOString().slice(0, 10);
}

function activeLoansFor(db, rubbingId) {
  return listLoans(db).filter((loan) => loan.status === "active" && loan.rubbingIds.includes(rubbingId));
}

// 当前处于借展期内的借展单（区间覆盖判断与冲突模块一致，按字典序比较）
function currentLoan(db, rubbingId, date = today()) {
  return activeLoansFor(db, rubbingId).find((loan) => loan.startDate <= date && date <= loan.endDate) || null;
}

function loanStatusFor(db, rubbingId, date = today()) {
  const current = currentLoan(db, rubbingId, date);
  if (current) return { loanStatus: LOAN_STATUS.ON_LOAN, loanId: current.id };
  const future = activeLoansFor(db, rubbingId).find((loan) => date < loan.startDate);
  if (future) return { loanStatus: LOAN_STATUS.RESERVED, loanId: future.id };
  return { loanStatus: LOAN_STATUS.AVAILABLE, loanId: null };
}

// 在既有拓片响应字段上追加借展状态，保持兼容
function decorateRubbing(db, rubbing) {
  return { ...rubbing, ...loanStatusFor(db, rubbing.id) };
}

module.exports = { LOAN_STATUS, activeLoansFor, currentLoan, loanStatusFor, decorateRubbing };
