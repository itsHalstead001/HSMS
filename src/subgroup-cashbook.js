const {
  calculateCashSummary,
  toCents,
  fromCents
} = require('./meeting-cashbook');

const subgroupCodes = Object.freeze(['A', 'B', 'C', 'D']);

function createSubgroupCashbookSummaries(meetings, submissions, initialBalance = '0.00') {
  const byMeeting = new Map();
  for (const submission of submissions) {
    const key = String(submission.meeting_id);
    if (!byMeeting.has(key)) byMeeting.set(key, []);
    byMeeting.get(key).push(submission);
  }

  let openingBalance = fromCents(toCents(initialBalance));
  return meetings.map((meeting) => {
    const rows = byMeeting.get(String(meeting.id)) || [];
    const totalsInCents = {
      fine: 0,
      social: 0,
      savings: 0,
      loan_return: 0,
      loan_disbursement: 0
    };
    const subgroupRows = new Map(rows.map((row) => [row.subgroup_code, row]));
    for (const row of rows) {
      totalsInCents.fine += toCents(row.fines);
      totalsInCents.social += toCents(row.socials);
      totalsInCents.savings += toCents(row.savings);
      totalsInCents.loan_return += toCents(row.loan_return);
      totalsInCents.loan_disbursement += toCents(row.loan_taken);
    }
    const totals = Object.fromEntries(
      Object.entries(totalsInCents).map(([key, value]) => [key, fromCents(value)])
    );
    const summary = calculateCashSummary(openingBalance, totals);
    openingBalance = summary.closing_balance;

    return {
      ...meeting,
      summary,
      subgroups: subgroupCodes.map((code) => {
        const row = subgroupRows.get(code);
        return {
          code,
          submitted: Boolean(row && row.submitted_at),
          pendingChanges: Boolean(row && row.pending_changes),
          fines: row ? row.fines : '0.00',
          socials: row ? row.socials : '0.00',
          savings: row ? row.savings : '0.00',
          loan_return: row ? row.loan_return : '0.00',
          loan_taken: row ? row.loan_taken : '0.00',
          updated_at: row ? row.updated_at : null
        };
      })
    };
  });
}

module.exports = { createSubgroupCashbookSummaries };
