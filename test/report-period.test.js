const test = require('node:test');
const assert = require('node:assert/strict');
const { getReportPeriod } = require('../src/report-period');

test('calculates a Monday-through-Sunday weekly report range', () => {
  assert.deepEqual(getReportPeriod('weekly', '2026-11-05'), {
    period: 'weekly',
    start: '2026-11-02',
    end: '2026-11-08',
    label: 'Week of 2026-11-02 to 2026-11-08',
    filename: 'week-2026-11-02'
  });
});

test('calculates calendar month, quarter and leap-year ranges', () => {
  assert.deepEqual(getReportPeriod('monthly', '2026-11-05'), {
    period: 'monthly', start: '2026-11-01', end: '2026-11-30',
    label: 'November 2026', filename: '2026-11'
  });
  assert.deepEqual(getReportPeriod('quarterly', '2026-11-05'), {
    period: 'quarterly', start: '2026-10-01', end: '2026-12-31',
    label: 'Quarter 4, 2026', filename: '2026-Q4'
  });
  assert.equal(getReportPeriod('yearly', '2024-02-29').end, '2024-12-31');
});

test('rejects invalid date and report period input', () => {
  assert.throws(() => getReportPeriod('daily', '2026-11-05'), /Choose a weekly/);
  assert.throws(() => getReportPeriod('monthly', '2026-02-30'), /valid date/);
});
