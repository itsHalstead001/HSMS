const test = require('node:test');
const assert = require('node:assert/strict');
const { createSubgroupCashbookSummaries } = require('../src/subgroup-cashbook');

test('aggregates subgroup totals and carries the remainder into the next meeting', () => {
  const meetings = [{ id: 1 }, { id: 2 }];
  const submissions = [
    { meeting_id: 1, subgroup_code: 'A', fines: '12.30', socials: '5.00', savings: '40.00', loan_return: '10.00', loan_taken: '15.00', submitted_at: '2026-01-01', pending_changes: false },
    { meeting_id: 1, subgroup_code: 'B', fines: '2.70', socials: '3.00', savings: '10.00', loan_return: '5.00', loan_taken: '20.00', submitted_at: '2026-01-01', pending_changes: true },
    { meeting_id: 2, subgroup_code: 'C', fines: '1.00', socials: '0.00', savings: '4.00', loan_return: '0.00', loan_taken: '2.50', submitted_at: '2026-01-01', pending_changes: false }
  ];

  const summaries = createSubgroupCashbookSummaries(meetings, submissions);

  assert.equal(summaries[0].summary.fine, '15.00');
  assert.equal(summaries[0].summary.current_collections, '88.00');
  assert.equal(summaries[0].summary.loans_disbursed, '35.00');
  assert.equal(summaries[0].summary.closing_balance, '53.00');
  assert.equal(summaries[0].subgroups.length, 4);
  assert.equal(summaries[0].subgroups[0].submitted, true);
  assert.equal(summaries[0].subgroups[0].pendingChanges, false);
  assert.equal(summaries[0].subgroups[1].pendingChanges, true);
  assert.equal(summaries[0].subgroups[2].submitted, false);
  assert.equal(summaries[1].summary.opening_balance, '53.00');
  assert.equal(summaries[1].summary.closing_balance, '55.50');
});

test('keeps unsent subgroup amounts at zero without exposing member-level data', () => {
  const [meeting] = createSubgroupCashbookSummaries([{ id: 8 }], []);

  assert.deepEqual(meeting.subgroups.map(({ code, submitted, pendingChanges, fines }) => ({ code, submitted, pendingChanges, fines })), [
    { code: 'A', submitted: false, pendingChanges: false, fines: '0.00' },
    { code: 'B', submitted: false, pendingChanges: false, fines: '0.00' },
    { code: 'C', submitted: false, pendingChanges: false, fines: '0.00' },
    { code: 'D', submitted: false, pendingChanges: false, fines: '0.00' }
  ]);
  assert.equal(Object.hasOwn(meeting.subgroups[0], 'member_id'), false);
  assert.equal(meeting.summary.closing_balance, '0.00');
});

test('uses the migrated opening balance as the first meeting carry-forward', () => {
  const [meeting] = createSubgroupCashbookSummaries([{ id: 4 }], [], '125.75');

  assert.equal(meeting.summary.opening_balance, '125.75');
  assert.equal(meeting.summary.closing_balance, '125.75');
});
