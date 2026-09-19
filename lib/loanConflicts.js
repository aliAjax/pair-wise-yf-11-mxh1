// 借展冲突校验模块：未修复缺损检查 + 借展区间重叠检查
const { listLoans } = require("./loanStore");

// 指定拓片集合内所有未修复缺损
function unrepairedDamages(db, rubbingIds) {
  const wanted = new Set(rubbingIds);
  return db.damages.filter((damage) => wanted.has(damage.rubbingId) && damage.status !== "repaired");
}

// 闭区间重叠判断，日期为 YYYY-MM-DD 字符串，可直接按字典序比较
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// 同一拓片与未结束（active）借展的区间重叠；已归还/已取消不占用
function overlappingLoans(db, rubbingId, startDate, endDate, excludeLoanId = null) {
  return listLoans(db).filter(
    (loan) =>
      loan.status === "active" &&
      loan.id !== excludeLoanId &&
      loan.rubbingIds.includes(rubbingId) &&
      rangesOverlap(startDate, endDate, loan.startDate, loan.endDate)
  );
}

// 整单冲突检查：任一拓片有未修复缺损，或任一拓片区间冲突，即视为冲突
function checkLoanConflicts(db, { rubbingIds, startDate, endDate }) {
  const unrepaired = rubbingIds
    .map((rubbingId) => ({ rubbingId, damages: unrepairedDamages(db, [rubbingId]) }))
    .filter((entry) => entry.damages.length > 0)
    .map((entry) => ({ rubbingId: entry.rubbingId, damageIds: entry.damages.map((damage) => damage.id) }));

  const overlaps = rubbingIds.flatMap((rubbingId) =>
    overlappingLoans(db, rubbingId, startDate, endDate).map((loan) => ({
      rubbingId,
      loanId: loan.id,
      unit: loan.unit,
      startDate: loan.startDate,
      endDate: loan.endDate
    }))
  );

  return { hasConflict: unrepaired.length > 0 || overlaps.length > 0, unrepaired, overlaps };
}

module.exports = { unrepairedDamages, rangesOverlap, overlappingLoans, checkLoanConflicts };
