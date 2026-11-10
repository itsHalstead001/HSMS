const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cashCategories,
  nextThursdayDate,
  addWeeks,
  meetingDateTime,
  calculateCashSummary
} = require('../src/meeting-cashbook');

test('next Thursday is strictly in the future, including on Thursday', () => {
  assert.equal(nextThursdayDate(new Date('2026-11-03T08:00:00')), '2026-11-05');
  assert.equal(nextThursdayDate(new Date('2026-11-05T08:00:00')), '2026-11-12');
  assert.equal(nextThursdayDate(new Date('2026-11-08T08:00:00')), '2026-11-12');
});

test('weekly meeting dates advance by seven days and default to 10:00', () => {
  assert.equal(addWeeks('2026-12-31', 1), '2027-01-07');
  assert.equal(meetingDateTime('2027-01-07'), '2027-01-07T10:00');
});

test('cashbook carries forward opening cash and subtracts loan disbursements', () => {
  const summary = calculateCashSummary('25.50', {
    fine: '5.25',
    social: '10.00',
    savings: '100.00',
    loan_return: '20.00',
    loan_disbursement: '80.75'
  });
  assert.deepEqual(summary, {
    fine: '5.25',
    social: '10.00',
    savings: '100.00',
    loan_return: '20.00',
    opening_balance: '25.50',
    current_collections: '135.25',
    cash_available: '160.75',
    loans_disbursed: '80.75',
    closing_balance: '80.00'
  });
  assert.deepEqual(cashCategories, ['fine', 'social', 'savings', 'loan_return']);
});
