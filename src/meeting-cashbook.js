const cashCategories = Object.freeze(['fine', 'social', 'savings', 'loan_return']);

function nextThursdayDate(reference = new Date()) {
  const today = Date.UTC(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const weekday = new Date(today).getUTCDay();
  const daysUntilThursday = (4 - weekday + 7) % 7 || 7;
  return new Date(today + daysUntilThursday * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addWeeks(dateValue, weeks) {
  const date = new Date(`${dateValue}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

function meetingDateTime(dateValue) {
  return `${dateValue}T10:00`;
}

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function fromCents(value) {
  return (value / 100).toFixed(2);
}

function calculateCashSummary(openingBalance, totals) {
  const summary = Object.fromEntries(
    cashCategories.map((category) => [category, fromCents(toCents(totals[category]))])
  );
  const openingCents = toCents(openingBalance);
  const collectionCents = cashCategories.reduce((total, category) => total + toCents(totals[category]), 0);
  const disbursedCents = toCents(totals.loan_disbursement);
  const availableCents = openingCents + collectionCents;
  return {
    ...summary,
    opening_balance: fromCents(openingCents),
    current_collections: fromCents(collectionCents),
    cash_available: fromCents(availableCents),
    loans_disbursed: fromCents(disbursedCents),
    closing_balance: fromCents(availableCents - disbursedCents)
  };
}

module.exports = {
  cashCategories,
  nextThursdayDate,
  addWeeks,
  meetingDateTime,
  calculateCashSummary,
  toCents,
  fromCents
};
