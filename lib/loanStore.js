// 借展存储模块：负责 db.loans 集合的读写，不关心业务规则

function loans(db) {
  if (!Array.isArray(db.loans)) db.loans = [];
  return db.loans;
}

function listLoans(db) {
  return loans(db);
}

function findLoan(db, id) {
  return loans(db).find((loan) => loan.id === id) || null;
}

function insertLoan(db, loan) {
  loans(db).push(loan);
  return loan;
}

function saveLoan(db, updated) {
  const items = loans(db);
  const index = items.findIndex((loan) => loan.id === updated.id);
  if (index === -1) return null;
  items[index] = updated;
  return updated;
}

module.exports = { listLoans, findLoan, insertLoan, saveLoan };
