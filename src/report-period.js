const reportPeriods = Object.freeze(['weekly', 'monthly', 'quarterly', 'yearly']);

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function getReportPeriod(period, selectedDate) {
  if (!reportPeriods.includes(period)) {
    throw new Error('Choose a weekly, monthly, quarterly or yearly report.');
  }
  if (typeof selectedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
    throw new Error('Choose a valid date for the report period.');
  }
  const date = new Date(`${selectedDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || isoDate(date) !== selectedDate) {
    throw new Error('Choose a valid date for the report period.');
  }

  let start;
  let end;
  if (period === 'weekly') {
    const weekday = (date.getUTCDay() + 6) % 7;
    start = new Date(date);
    start.setUTCDate(date.getUTCDate() - weekday);
    end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
  } else if (period === 'monthly') {
    start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  } else if (period === 'quarterly') {
    const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
    start = new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth, 1));
    end = new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth + 3, 0));
  } else {
    start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    end = new Date(Date.UTC(date.getUTCFullYear(), 11, 31));
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const label = period === 'weekly'
    ? `Week of ${isoDate(start)} to ${isoDate(end)}`
    : period === 'monthly'
      ? date.toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      : period === 'quarterly' ? `Quarter ${quarter}, ${year}` : String(year);
  const filename = period === 'weekly'
    ? `week-${isoDate(start)}`
    : period === 'monthly' ? `${year}-${month}`
      : period === 'quarterly' ? `${year}-Q${quarter}` : String(year);

  return {
    period,
    start: isoDate(start),
    end: isoDate(end),
    label,
    filename
  };
}

module.exports = { reportPeriods, getReportPeriod };
