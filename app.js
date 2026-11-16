require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const MySQLSessionStore = require('./src/mysql-session-store');
const bcrypt = require('bcrypt');
const PDFDocument = require('pdfkit');
const helmet = require('helmet');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const db = require('./src/db');
const {
  cashCategories,
  nextThursdayDate,
  addWeeks,
  meetingDateTime,
  calculateCashSummary,
  toCents,
  fromCents
} = require('./src/meeting-cashbook');
const { createSubgroupCashbookSummaries } = require('./src/subgroup-cashbook');
const { reportPeriods, getReportPeriod } = require('./src/report-period');
const { formatMemberContributionSms, sendGalatextSms } = require('./src/member-notification');

const app = express();
const port = Number(process.env.PORT || 3001);
const roles = {
  chairperson: 'Chairperson',
  secretary: 'Secretary',
  financial_secretary: 'Financial Secretary',
  treasurer: 'Treasurer',
  subgroup_chairperson: 'Subgroup Chairperson',
  subgroup_secretary: 'Subgroup Secretary'
};
const subgroupCodes = ['A', 'B', 'C', 'D'];
const uploadDirectory = path.resolve(process.env.UPLOAD_DIR || 'storage/documents');
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024;
fs.mkdirSync(uploadDirectory, { recursive: true });

if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: '128kb', parameterLimit: 5000 }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));

const sessionStore = new MySQLSessionStore(db.pool);
const sessionCleanup = setInterval(() => {
  db.pool.execute('DELETE FROM sessions WHERE expires <= ?', [Math.floor(Date.now() / 1000)])
    .catch((error) => console.error('Session cleanup failed:', error));
}, 15 * 60 * 1000);
sessionCleanup.unref();
app.use(session({
  name: 'hsms.sid',
  secret: process.env.SESSION_SECRET || 'development-secret-change-this-before-deploying',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || process.env.SESSION_COOKIE_SECURE === 'true',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.roles = roles;
  res.locals.csrfToken = req.session.csrfToken || (req.session.csrfToken = crypto.randomBytes(32).toString('hex'));
  res.locals.groupName = 'Halstead Self-Help Group';
  res.locals.currency = 'KES';
  res.locals.reportDate = new Date().toISOString().slice(0, 10);
  res.locals.maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 10);
  res.locals.notice = typeof req.query.notice === 'string' ? req.query.notice : '';
  res.locals.noticeType = req.query.noticeType === 'error' ? 'error' : 'success';
  db.pool.execute(
    'SELECT setting_key, setting_value FROM group_settings WHERE setting_key IN (?, ?)',
    ['group_name', 'currency']
  ).then(([rows]) => {
    const settings = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
    res.locals.groupName = settings.group_name || res.locals.groupName;
    res.locals.currency = settings.currency || res.locals.currency;
    next();
  }).catch(next);
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireAuth(req, res, next) {
  checkAuthenticatedUser(req, res, next);
}

function allowRoles(...allowedRoles) {
  return (req, res, next) => {
    checkAuthenticatedUser(req, res, next, allowedRoles);
  };
}

function checkAuthenticatedUser(req, res, next, allowedRoles) {
  if (!req.session.user) return res.redirect('/login');
  db.pool.execute(
    'SELECT id, username, full_name, role, subgroup_code, is_active FROM users WHERE id = ? LIMIT 1',
    [req.session.user.id]
  ).then(([rows]) => {
    const account = rows[0];
    if (!account || !account.is_active) {
      return req.session.destroy((error) => {
        if (error) return next(error);
        res.clearCookie('hsms.sid');
        res.redirect('/login');
      });
    }
    req.session.user = {
      id: account.id, username: account.username,
      fullName: account.full_name, role: account.role,
      subgroupCode: account.subgroup_code
    };
    res.locals.user = req.session.user;
    if (allowedRoles && !allowedRoles.includes(account.role)) {
      return res.status(403).render('error', {
        title: 'Access not allowed',
        message: 'Your account does not have permission to open this page.'
      });
    }
    next();
  }).catch(next);
}

function validCsrfToken(req, submitted) {
  const expected = req.session.csrfToken;
  return typeof submitted === 'string' && typeof expected === 'string' &&
    submitted.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
}

app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.is('multipart/form-data')) {
    if (req.method === 'POST' && req.path === '/documents') return next();
    return res.status(403).render('error', {
      title: 'Page expired',
      message: 'This form could not be verified. Go back, refresh the page, and try again.'
    });
  }
  const submitted = req.body && req.body._csrf;
  if (!validCsrfToken(req, submitted)) {
    return res.status(403).render('error', {
      title: 'Page expired',
      message: 'This form could not be verified. Go back, refresh the page, and try again.'
    });
  }
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.'
});

function positiveMoney(value, fieldName = 'Amount') {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || !/^\d{1,10}(\.\d{1,2})?$/.test(String(value).trim())) {
    throw new Error(`${fieldName} must be a non-negative amount with up to two decimal places.`);
  }
  return amount.toFixed(2);
}

function nonZeroMoney(value, fieldName = 'Amount') {
  const amount = positiveMoney(value, fieldName);
  if (Number(amount) === 0) throw new Error(`${fieldName} must be greater than zero.`);
  return amount;
}

function requiredText(value, fieldName, maxLength = 500) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength) throw new Error(`${fieldName} is required and must be under ${maxLength} characters.`);
  return text;
}

function positiveInteger(value, fieldName, max = 120) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`${fieldName} must be between 1 and ${max}.`);
  return number;
}

function positiveId(value, fieldName) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (text.length > 20 || !/^[1-9]\d*$/.test(text) || BigInt(text) > 18446744073709551615n) {
    throw new Error(`${fieldName} is invalid.`);
  }
  return text;
}

function dateValue(value, fieldName = 'Date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${fieldName} is invalid.`);
  }
  return value;
}

function redirectNotice(res, url, message, type = 'success') {
  const separator = url.includes('?') ? '&' : '?';
  return res.redirect(`${url}${separator}notice=${encodeURIComponent(message)}&noticeType=${type}`);
}

async function transaction(work) {
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function ensureWeeklyMeetings() {
  const firstDate = nextThursdayDate();
  for (let week = 0; week < 8; week += 1) {
    const occurrence = addWeeks(firstDate, week);
    const [existing] = await db.pool.execute(
      'SELECT id FROM meetings WHERE DATE(meeting_date) = ? LIMIT 1',
      [occurrence]
    );
    if (existing.length) continue;
    await db.pool.execute(
      `INSERT INTO meetings (title, meeting_date, weekly_occurrence)
       VALUES ('Weekly SHG Meeting', ?, ?)
       ON DUPLICATE KEY UPDATE weekly_occurrence = VALUES(weekly_occurrence)`,
      [meetingDateTime(occurrence).replace('T', ' ') + ':00', occurrence]
    );
  }
}

async function meetingCashTotals(executor, meetingId) {
  const [rows] = await executor.execute(
    `SELECT transaction_type, COALESCE(SUM(amount), 0) AS total
     FROM transactions WHERE meeting_id = ? AND is_voided = FALSE
     GROUP BY transaction_type`,
    [meetingId]
  );
  return Object.fromEntries(rows.map((row) => [row.transaction_type, row.total]));
}

async function syncMemberContribution(connection, meetingId, memberId, category, amount, memberName, userId) {
  const [existing] = await connection.execute(
    `SELECT t.id AS transaction_id, t.amount, c.id AS contribution_id
     FROM transactions t LEFT JOIN contributions c ON c.transaction_id = t.id
     WHERE t.meeting_id = ? AND t.related_id = ? AND t.transaction_type = ?
       AND t.is_voided = FALSE
     ORDER BY t.id FOR UPDATE`,
    [meetingId, memberId, category]
  );
  const cents = toCents(amount);
  if (cents === 0) {
    for (const row of existing) {
      await connection.execute('UPDATE transactions SET is_voided = TRUE WHERE id = ?', [row.transaction_id]);
    }
    return;
  }
  if (existing.length) {
    const [primary, ...duplicates] = existing;
    await connection.execute(
      'UPDATE transactions SET amount = ?, created_by = ? WHERE id = ?',
      [fromCents(cents), userId, primary.transaction_id]
    );
    if (primary.contribution_id) {
      await connection.execute(
        'UPDATE contributions SET amount = ? WHERE id = ?',
        [fromCents(cents), primary.contribution_id]
      );
    }
    for (const duplicate of duplicates) {
      await connection.execute('UPDATE transactions SET is_voided = TRUE WHERE id = ?', [duplicate.transaction_id]);
    }
    return;
  }

  const [ledger] = await connection.execute(
    `INSERT INTO transactions
     (transaction_type, amount, transaction_date, description, related_id, meeting_id, created_by)
     VALUES (?, ?, NOW(), ?, ?, ?, ?)`,
    [category, fromCents(cents), `${category[0].toUpperCase()}${category.slice(1)} — ${memberName}`, memberId, meetingId, userId]
  );
  await connection.execute(
    `INSERT INTO contributions (member_id, amount, category, contribution_date, transaction_id)
     VALUES (?, ?, ?, NOW(), ?)`,
    [memberId, fromCents(cents), category, ledger.insertId]
  );
}

async function recalculateLoanAfterRepaymentChanges(connection, loanId) {
  const [loans] = await connection.execute('SELECT * FROM loans WHERE id = ? FOR UPDATE', [loanId]);
  const loan = loans[0];
  if (!loan || !loan.disbursed_at) return;
  const [schedule] = await connection.execute(
    'SELECT id, amount_due FROM repayment_schedule WHERE loan_id = ? ORDER BY installment_number FOR UPDATE',
    [loanId]
  );
  const [repayments] = await connection.execute(
    `SELECT lr.amount FROM loan_repayments lr
     JOIN transactions t ON t.id = lr.transaction_id
     WHERE lr.loan_id = ? AND t.is_voided = FALSE
     ORDER BY lr.repayment_date, lr.id`,
    [loanId]
  );
  const totalDueCents = schedule.length
    ? schedule.reduce((total, installment) => total + toCents(installment.amount_due), 0)
    : Math.round(Number(loan.amount) * (1 + Number(loan.interest_rate) / 100 * Number(loan.term_months) / 12) * 100);
  const totalPaidCents = repayments.reduce((total, repayment) => total + toCents(repayment.amount), 0);
  if (totalPaidCents > totalDueCents) throw new Error('Repayments exceed the loan schedule after this correction.');

  for (const installment of schedule) {
    await connection.execute(
      'UPDATE repayment_schedule SET amount_paid = 0.00, paid_at = NULL WHERE id = ?',
      [installment.id]
    );
  }
  let remainingCents = totalPaidCents;
  for (const installment of schedule) {
    if (remainingCents <= 0) break;
    const appliedCents = Math.min(toCents(installment.amount_due), remainingCents);
    await connection.execute(
      'UPDATE repayment_schedule SET amount_paid = ?, paid_at = IF(? >= amount_due, NOW(), NULL) WHERE id = ?',
      [fromCents(appliedCents), fromCents(appliedCents), installment.id]
    );
    remainingCents -= appliedCents;
  }
  const balanceCents = totalDueCents - totalPaidCents;
  await connection.execute(
    "UPDATE loans SET balance = ?, status = IF(? = 0, 'repaid', 'active') WHERE id = ?",
    [fromCents(balanceCents), balanceCents, loanId]
  );
}

async function syncMemberLoanReturn(connection, meetingId, memberId, amount, userId) {
  const [existing] = await connection.execute(
    `SELECT lr.id, lr.loan_id, lr.transaction_id
     FROM loan_repayments lr
     JOIN loans l ON l.id = lr.loan_id
     JOIN transactions t ON t.id = lr.transaction_id
     WHERE lr.meeting_id = ? AND l.member_id = ? AND t.transaction_type = 'loan_return'
       AND t.is_voided = FALSE
     ORDER BY lr.id FOR UPDATE`,
    [meetingId, memberId]
  );
  const affectedLoanIds = new Set(existing.map((row) => String(row.loan_id)));
  for (const row of existing) {
    await connection.execute('UPDATE transactions SET is_voided = TRUE WHERE id = ?', [row.transaction_id]);
  }
  for (const loanId of affectedLoanIds) {
    await recalculateLoanAfterRepaymentChanges(connection, loanId);
  }

  let remainingCents = toCents(amount);
  if (remainingCents === 0) return;
  const [loans] = await connection.execute(
    `SELECT id, balance FROM loans
     WHERE member_id = ? AND status = 'active' AND balance > 0
     ORDER BY application_date, id FOR UPDATE`,
    [memberId]
  );
  const outstandingCents = loans.reduce((total, loan) => total + toCents(loan.balance), 0);
  if (remainingCents > outstandingCents) {
    throw new Error('Loan return exceeds this member’s active loan balance.');
  }
  for (const loan of loans) {
    if (remainingCents === 0) break;
    const appliedCents = Math.min(remainingCents, toCents(loan.balance));
    await recordLoanRepayment(connection, loan, fromCents(appliedCents), meetingId, userId);
    remainingCents -= appliedCents;
  }
}

async function subgroupMeetingTotals(executor, meetingId, subgroupCode) {
  const [[collections]] = await executor.execute(
    `SELECT COALESCE(SUM(fine), 0) AS fine, COALESCE(SUM(social), 0) AS social,
       COALESCE(SUM(savings), 0) AS savings, COALESCE(SUM(loan_return), 0) AS loan_return
     FROM subgroup_member_meeting_records WHERE meeting_id = ? AND subgroup_code = ?`,
    [meetingId, subgroupCode]
  );
  const [[loans]] = await executor.execute(
    `SELECT COALESCE(SUM(t.amount), 0) AS loan_taken FROM transactions t
     JOIN loans l ON l.id = t.related_id
     JOIN members m ON m.id = l.member_id
     WHERE t.meeting_id = ? AND t.transaction_type = 'loan_disbursement'
       AND t.is_voided = FALSE AND m.subgroup_code = ?`,
    [meetingId, subgroupCode]
  );
  return {
    fine: fromCents(toCents(collections.fine)),
    social: fromCents(toCents(collections.social)),
    savings: fromCents(toCents(collections.savings)),
    loan_return: fromCents(toCents(collections.loan_return)),
    loan_taken: fromCents(toCents(loans.loan_taken))
  };
}

async function ensureMeetingCashbook(connection, meetingId, userId) {
  const [meetings] = await connection.execute(
    'SELECT id FROM meetings WHERE id = ? FOR UPDATE',
    [meetingId]
  );
  if (!meetings.length) throw Object.assign(new Error('That meeting could not be found.'), { status: 404 });

  const [cashbooks] = await connection.execute(
    'SELECT opening_balance FROM meeting_cashbooks WHERE meeting_id = ? FOR UPDATE',
    [meetingId]
  );
  if (cashbooks.length) return cashbooks[0].opening_balance;

  const [previous] = await connection.execute(
    `SELECT cb.meeting_id, cb.opening_balance
     FROM meeting_cashbooks cb
     JOIN meetings m ON m.id = cb.meeting_id
     WHERE m.meeting_date < (SELECT meeting_date FROM meetings WHERE id = ?)
     ORDER BY m.meeting_date DESC, m.id DESC
     LIMIT 1`,
    [meetingId]
  );
  let openingBalance = '0.00';
  if (previous.length) {
    const totals = await meetingCashTotals(connection, previous[0].meeting_id);
    openingBalance = calculateCashSummary(previous[0].opening_balance, totals).closing_balance;
  } else {
    const [[currentMeeting]] = await connection.execute(
      'SELECT DATE(meeting_date) AS meeting_day FROM meetings WHERE id = ?',
      [meetingId]
    );
    const [openingConfig] = await connection.execute(
      'SELECT opening_balance, effective_from FROM subgroup_cashbook_config WHERE id = 1'
    );
    if (openingConfig.length && currentMeeting.meeting_day >= openingConfig[0].effective_from) {
      openingBalance = openingConfig[0].opening_balance;
    }
  }
  await connection.execute(
    'INSERT INTO meeting_cashbooks (meeting_id, opening_balance, created_by) VALUES (?, ?, ?)',
    [meetingId, openingBalance, userId]
  );
  return openingBalance;
}

async function recalculateCashbookCarryForwards(connection) {
  const [cashbooks] = await connection.execute(
    `SELECT cb.meeting_id, cb.opening_balance
     FROM meeting_cashbooks cb JOIN meetings m ON m.id = cb.meeting_id
     ORDER BY m.meeting_date ASC, m.id ASC FOR UPDATE`
  );
  for (let index = 1; index < cashbooks.length; index += 1) {
    const previous = cashbooks[index - 1];
    const totals = await meetingCashTotals(connection, previous.meeting_id);
    const closing = calculateCashSummary(previous.opening_balance, totals).closing_balance;
    await connection.execute(
      'UPDATE meeting_cashbooks SET opening_balance = ? WHERE meeting_id = ?',
      [closing, cashbooks[index].meeting_id]
    );
    cashbooks[index].opening_balance = closing;
  }
}

async function recordLoanRepayment(connection, loan, amount, meetingId, userId) {
  const amountCents = toCents(amount);
  const loanType = meetingId ? 'loan_return' : 'loan_repayment';
  const [ledger] = await connection.execute(
    'INSERT INTO transactions (transaction_type, amount, transaction_date, description, related_id, meeting_id, created_by) VALUES (?, ?, NOW(), ?, ?, ?, ?)',
    [loanType, amount, `Loan return — ${loan.id}`, loan.id, meetingId, userId]
  );
  await connection.execute(
    'INSERT INTO loan_repayments (loan_id, amount, repayment_date, transaction_id, meeting_id) VALUES (?, ?, NOW(), ?, ?)',
    [loan.id, amount, ledger.insertId, meetingId]
  );
  let remainingCents = amountCents;
  const [schedule] = await connection.execute(
    'SELECT id, amount_due, amount_paid FROM repayment_schedule WHERE loan_id = ? ORDER BY installment_number FOR UPDATE',
    [loan.id]
  );
  for (const installment of schedule) {
    if (remainingCents <= 0) break;
    const dueCents = toCents(installment.amount_due);
    const paidCents = toCents(installment.amount_paid);
    const appliedCents = Math.min(dueCents - paidCents, remainingCents);
    if (appliedCents > 0) {
      const newPaid = fromCents(paidCents + appliedCents);
      await connection.execute(
        'UPDATE repayment_schedule SET amount_paid = ?, paid_at = IF(? >= amount_due, NOW(), NULL) WHERE id = ?',
        [newPaid, newPaid, installment.id]
      );
      remainingCents -= appliedCents;
    }
  }
  const balanceCents = Math.max(0, toCents(loan.balance) - amountCents);
  await connection.execute(
    "UPDATE loans SET balance = ?, status = IF(? = 0, 'repaid', 'active') WHERE id = ?",
    [fromCents(balanceCents), balanceCents, loan.id]
  );
}

async function disburseLoan(connection, loanId, meetingId, userId, requiredSubgroup = null) {
  const [loans] = await connection.execute(
    `SELECT l.*, m.subgroup_code FROM loans l
     JOIN members m ON m.id = l.member_id
     WHERE l.id = ? FOR UPDATE`,
    [loanId]
  );
  const loan = loans[0];
  if (!loan || loan.status !== 'approved') throw new Error('Only approved loans can be disbursed.');
  if (requiredSubgroup && loan.subgroup_code !== requiredSubgroup) {
    throw Object.assign(new Error('This loan does not belong to your subgroup.'), { status: 404 });
  }
  const openingBalance = await ensureMeetingCashbook(connection, meetingId, userId);
  const totals = await meetingCashTotals(connection, meetingId);
  const cash = calculateCashSummary(openingBalance, totals);
  if (toCents(loan.amount) > toCents(cash.cash_available)) {
    throw new Error(`The meeting cashbook has ${cash.cash_available} available, which is not enough to disburse this loan.`);
  }
  const totalDue = Number(loan.amount) * (1 + Number(loan.interest_rate) / 100 * Number(loan.term_months) / 12);
  const totalCents = Math.round(totalDue * 100);
  const baseCents = Math.floor(totalCents / Number(loan.term_months));
  const now = new Date();
  const firstDue = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  for (let i = 1; i <= Number(loan.term_months); i += 1) {
    const dueDate = new Date(Date.UTC(firstDue.getUTCFullYear(), firstDue.getUTCMonth() + i - 1, 1));
    const installmentCents = i === Number(loan.term_months)
      ? totalCents - baseCents * (Number(loan.term_months) - 1) : baseCents;
    await connection.execute(
      'INSERT INTO repayment_schedule (loan_id, installment_number, due_date, amount_due) VALUES (?, ?, ?, ?)',
      [loan.id, i, dueDate.toISOString().slice(0, 10), fromCents(installmentCents)]
    );
  }
  await connection.execute(
    "UPDATE loans SET status = 'active', balance = ?, disbursed_at = NOW() WHERE id = ?",
    [fromCents(totalCents), loan.id]
  );
  await connection.execute(
    `INSERT INTO transactions
     (transaction_type, amount, transaction_date, description, related_id, meeting_id, created_by)
     VALUES (?, ?, NOW(), ?, ?, ?, ?)`,
    ['loan_disbursement', loan.amount, `Loan disbursement — ${loan.id}`, loan.id, meetingId, userId]
  );
  if (subgroupCodes.includes(loan.subgroup_code)) {
    await connection.execute(
      `INSERT INTO subgroup_cashbook_submissions (meeting_id, subgroup_code, pending_changes)
       VALUES (?, ?, TRUE)
       ON DUPLICATE KEY UPDATE pending_changes = TRUE`,
      [meetingId, loan.subgroup_code]
    );
  }
  await recalculateCashbookCarryForwards(connection);
}

async function setting(key, fallback) {
  const [rows] = await db.pool.execute('SELECT setting_value FROM group_settings WHERE setting_key = ?', [key]);
  return rows.length ? rows[0].setting_value : fallback;
}

function csvCell(value) {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function sendPdfTable(res, filename, title, subtitle, columns, rows, summaryRows = []) {
  const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  document.on('error', (error) => {
    if (res.headersSent) res.destroy(error);
    else res.status(500).end();
  });
  res.type('application/pdf');
  res.attachment(filename);
  document.pipe(res);
  const pageWidth = document.page.width - document.page.margins.left - document.page.margins.right;
  const widths = columns.map((column) => column.width);
  const widthTotal = widths.reduce((total, width) => total + width, 0);
  const scale = pageWidth / widthTotal;
  const drawHeader = () => {
    let x = document.page.margins.left;
    document.font('Helvetica-Bold').fontSize(9).fillColor('#183c32');
    columns.forEach((column, index) => {
      document.text(column.label, x + 5, document.y, { width: widths[index] * scale - 10, lineBreak: false });
      x += widths[index] * scale;
    });
    document.moveDown(0.7).strokeColor('#6fa17c').lineWidth(1)
      .moveTo(document.page.margins.left, document.y)
      .lineTo(document.page.width - document.page.margins.right, document.y).stroke();
    document.moveDown(0.45);
  };
  document.font('Helvetica-Bold').fontSize(18).fillColor('#183c32').text(title);
  document.moveDown(0.2);
  document.font('Helvetica').fontSize(10).fillColor('#53645a').text(subtitle);
  document.moveDown(1.2);
  drawHeader();
  const drawRow = (values, bold = false) => {
    if (document.y > document.page.height - document.page.margins.bottom - 42) {
      document.addPage();
      drawHeader();
    }
    const y = document.y;
    let x = document.page.margins.left;
    document.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#202b24');
    values.forEach((value, index) => {
      document.text(String(value == null ? '' : value), x + 5, y, {
        width: widths[index] * scale - 10,
        height: 22,
        ellipsis: true,
        lineBreak: false
      });
      x += widths[index] * scale;
    });
    document.y = y + 23;
    document.strokeColor('#e5e9e5').lineWidth(0.5)
      .moveTo(document.page.margins.left, document.y)
      .lineTo(document.page.width - document.page.margins.right, document.y).stroke();
    document.y += 6;
  };
  rows.forEach((row) => drawRow(row));
  if (summaryRows.length) {
    document.moveDown(0.4);
    summaryRows.forEach((row) => drawRow(row, true));
  }
  document.end();
}

app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

app.get('/terms', (req, res) => {
  res.render('terms', { title: 'Terms & conditions' });
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Sign in', error: '' });
});

app.post('/login', loginLimiter, asyncRoute(async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(401).render('login', { title: 'Sign in', error: 'The username or password was not recognized.' });
  }
  const [users] = await db.pool.execute(
    'SELECT id, username, password_hash, full_name, role, subgroup_code, is_active FROM users WHERE username = ? LIMIT 1',
    [username]
  );
  const user = users[0];
  if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).render('login', { title: 'Sign in', error: 'The username or password was not recognized.' });
  }
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.user = {
    id: user.id, username: user.username, fullName: user.full_name,
    role: user.role, subgroupCode: user.subgroup_code
  };
  req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  await new Promise((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
  });
  res.redirect('/dashboard');
}));

app.post('/logout', requireAuth, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('hsms.sid');
    res.redirect('/login');
  });
});

app.get('/dashboard', requireAuth, asyncRoute(async (req, res) => {
  await ensureWeeklyMeetings();
  const role = req.session.user.role;
  const memberCountQuery = ['subgroup_chairperson', 'subgroup_secretary'].includes(role)
    ? "SELECT COUNT(*) AS total FROM members WHERE status = 'active' AND subgroup_code = ?"
    : "SELECT COUNT(*) AS total FROM members WHERE status = 'active'";
  const [[memberCount]] = await db.pool.execute(
    memberCountQuery,
    ['subgroup_chairperson', 'subgroup_secretary'].includes(role) ? [req.session.user.subgroupCode] : []
  );
  let funds = { balance: 0 };
  let loanSummary = { count: 0, balance: 0 };
  let recentTransactions = [];
  let recentMembers = [];
  if (['chairperson', 'treasurer'].includes(role)) {
    [[funds]] = await db.pool.execute(`
      SELECT COALESCE(SUM(CASE
        WHEN transaction_type IN ('registration_fee', 'contribution', 'fine', 'social', 'savings', 'loan_return', 'loan_repayment') THEN amount
        ELSE -amount END), 0) AS balance
      FROM transactions WHERE is_voided = FALSE
    `);
    [[loanSummary]] = await db.pool.execute(
      "SELECT COUNT(*) AS count, COALESCE(SUM(balance), 0) AS balance FROM loans WHERE status = 'active'"
    );
    [recentTransactions] = await db.pool.execute(
      'SELECT transaction_type, amount, transaction_date, description FROM transactions WHERE is_voided = FALSE ORDER BY transaction_date DESC, id DESC LIMIT 6'
    );
  } else if (role === 'secretary') {
    [recentMembers] = await db.pool.execute(
      'SELECT id, full_name, join_date FROM members ORDER BY created_at DESC LIMIT 5'
    );
  }
  const [upcomingMeetings] = await db.pool.execute(
    'SELECT id, title, meeting_date FROM meetings WHERE meeting_date >= NOW() ORDER BY meeting_date ASC LIMIT 4'
  );
  const [pendingLoans] = role === 'treasurer' || role === 'chairperson'
    ? await db.pool.execute(
      "SELECT l.id, l.amount, l.application_date, m.full_name FROM loans l JOIN members m ON m.id = l.member_id WHERE l.status = 'pending' ORDER BY l.application_date LIMIT 5"
    )
    : [[]];
  let monthContributions = '0.00';
  if (role === 'treasurer') {
    const [[monthly]] = await db.pool.execute(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE is_voided = FALSE AND transaction_type IN ('contribution', 'savings') AND transaction_date >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01')"
    );
    monthContributions = monthly.total;
  }
  res.render('dashboard', {
    title: 'Dashboard', role, memberCount: memberCount.total, funds: funds.balance,
    loanSummary, recentTransactions, recentMembers, upcomingMeetings,
    pendingLoans, monthContributions
  });
}));

app.get('/members', allowRoles('chairperson', 'secretary', 'treasurer', 'subgroup_chairperson', 'subgroup_secretary'), asyncRoute(async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const isSubgroupScoped = ['subgroup_chairperson', 'subgroup_secretary'].includes(req.session.user.role);
  const canViewFinancialData = ['chairperson', 'treasurer', 'subgroup_chairperson'].includes(req.session.user.role);
  const subgroupFilter = isSubgroupScoped ? 'm.subgroup_code = ? AND' : '';
  const searchParameters = [search, search, search, search];
  const [members] = await db.pool.execute(
    `SELECT m.id, m.full_name, m.phone, m.email, m.join_date, m.status, m.subgroup_code, s.name AS subgroup_name${canViewFinancialData ? ', m.registration_fee_paid' : ''}
     FROM members m LEFT JOIN subgroups s ON s.code = m.subgroup_code
     WHERE ${subgroupFilter} (? = '' OR m.full_name LIKE CONCAT('%', ?, '%') OR m.phone LIKE CONCAT('%', ?, '%') OR m.email LIKE CONCAT('%', ?, '%'))
     ORDER BY m.status = 'active' DESC, m.full_name ASC`,
    isSubgroupScoped ? [req.session.user.subgroupCode, ...searchParameters] : searchParameters
  );
  res.render('members/index', {
    title: 'Members', members, search, canViewFinancialData
  });
}));

app.get('/members/new', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  const [subgroups] = await db.pool.execute('SELECT code, name FROM subgroups ORDER BY code');
  res.render('members/form', {
    title: 'Register member', member: null, error: '',
    defaultFee: await setting('registration_fee', '0.00'),
    subgroups
  });
}));

app.post('/members', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  const fullName = requiredText(req.body.full_name, 'Full name', 160);
  const phone = typeof req.body.phone === 'string' ? req.body.phone.trim().slice(0, 40) : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().slice(0, 190) : '';
  const address = typeof req.body.address === 'string' ? req.body.address.trim().slice(0, 500) : '';
  const subgroupCode = subgroupCodes.includes(req.body.subgroup_code) ? req.body.subgroup_code : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (!subgroupCode) throw new Error('Assign the member to subgroup A, B, C or D.');
  const joinDate = dateValue(req.body.join_date || new Date().toISOString().slice(0, 10), 'Join date');
  const fee = positiveMoney(req.body.registration_fee || '0.00', 'Registration fee');

  const memberId = await transaction(async (connection) => {
    const [result] = await connection.execute(
      'INSERT INTO members (full_name, phone, email, address, subgroup_code, join_date, registration_fee_paid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [fullName, phone || null, email || null, address || null, subgroupCode, joinDate, fee]
    );
    if (Number(fee) > 0) {
      const [ledger] = await connection.execute(
        'INSERT INTO transactions (transaction_type, amount, transaction_date, description, related_id, created_by) VALUES (?, ?, NOW(), ?, ?, ?)',
        ['registration_fee', fee, `Registration fee — ${fullName}`, result.insertId, req.session.user.id]
      );
      await connection.execute(
        'INSERT INTO contributions (member_id, amount, category, contribution_date, transaction_id) VALUES (?, ?, ?, NOW(), ?)',
        [result.insertId, fee, 'registration_fee', ledger.insertId]
      );
    }
    return result.insertId;
  });
  redirectNotice(res, `/members/${memberId}`, 'Member registered successfully.');
}));

app.get('/members/:id', allowRoles('chairperson', 'secretary', 'treasurer', 'subgroup_chairperson', 'subgroup_secretary'), asyncRoute(async (req, res) => {
  const isSubgroupScoped = ['subgroup_chairperson', 'subgroup_secretary'].includes(req.session.user.role);
  const canViewFinancialData = ['chairperson', 'treasurer', 'subgroup_chairperson'].includes(req.session.user.role);
  const memberColumns = canViewFinancialData
    ? 'm.*'
    : 'm.id, m.full_name, m.phone, m.email, m.address, m.join_date, m.status, m.subgroup_code';
  const [members] = await db.pool.execute(
    `SELECT ${memberColumns}, s.name AS subgroup_name FROM members m
     LEFT JOIN subgroups s ON s.code = m.subgroup_code
     WHERE m.id = ?${isSubgroupScoped ? ' AND m.subgroup_code = ?' : ''}`,
    isSubgroupScoped ? [req.params.id, req.session.user.subgroupCode] : [req.params.id]
  );
  if (!members.length) return res.status(404).render('error', { title: 'Member not found', message: 'That member could not be found.' });
  let contributions = [];
  let loans = [];
  if (canViewFinancialData) {
    [contributions] = await db.pool.execute(
      `SELECT c.amount, c.contribution_date, t.transaction_type
       FROM contributions c JOIN transactions t ON t.id = c.transaction_id
       WHERE c.member_id = ? AND t.is_voided = FALSE ORDER BY c.contribution_date DESC LIMIT 20`,
      [req.params.id]
    );
    [loans] = await db.pool.execute(
      'SELECT id, amount, interest_rate, status, balance, application_date FROM loans WHERE member_id = ? ORDER BY application_date DESC',
      [req.params.id]
    );
  }
  res.render('members/show', {
    title: members[0].full_name, member: members[0], contributions, loans, canViewFinancialData
  });
}));

app.get('/members/:id/edit', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  const memberColumns = req.session.user.role === 'secretary'
    ? 'm.id, m.full_name, m.phone, m.email, m.address, m.join_date, m.status, m.subgroup_code'
    : '*';
  const [members] = await db.pool.execute(
    `SELECT ${memberColumns} FROM members m WHERE m.id = ?`,
    [req.params.id]
  );
  if (!members.length) return res.status(404).render('error', { title: 'Member not found', message: 'That member could not be found.' });
  const [subgroups] = await db.pool.execute('SELECT code, name FROM subgroups ORDER BY code');
  res.render('members/form', {
    title: 'Update member', member: members[0], error: '', defaultFee: '0.00', subgroups
  });
}));

app.post('/members/:id', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  const fullName = requiredText(req.body.full_name, 'Full name', 160);
  const phone = typeof req.body.phone === 'string' ? req.body.phone.trim().slice(0, 40) : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().slice(0, 190) : '';
  const address = typeof req.body.address === 'string' ? req.body.address.trim().slice(0, 500) : '';
  const subgroupCode = subgroupCodes.includes(req.body.subgroup_code) ? req.body.subgroup_code : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (!subgroupCode) throw new Error('Assign the member to subgroup A, B, C or D.');
  const status = ['active', 'inactive'].includes(req.body.status) ? req.body.status : null;
  if (!status) throw new Error('Select a valid member status.');
  const joinDate = dateValue(req.body.join_date, 'Join date');
  const [result] = await db.pool.execute(
    'UPDATE members SET full_name = ?, phone = ?, email = ?, address = ?, subgroup_code = ?, join_date = ?, status = ? WHERE id = ?',
    [fullName, phone || null, email || null, address || null, subgroupCode, joinDate, status, req.params.id]
  );
  if (!result.affectedRows) return res.status(404).render('error', { title: 'Member not found', message: 'That member could not be found.' });
  redirectNotice(res, `/members/${req.params.id}`, 'Member details updated.');
}));

app.post('/members/:id/delete', allowRoles('chairperson'), asyncRoute(async (req, res) => {
  const [result] = await db.pool.execute('DELETE FROM members WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).render('error', { title: 'Member not found', message: 'That member could not be found.' });
  redirectNotice(res, '/members', 'Member deleted.');
}));

app.get('/subgroup/cashbook', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  await ensureWeeklyMeetings();
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  const [meetings] = await db.pool.execute(
    `SELECT mt.id, mt.title, mt.meeting_date, ss.updated_at, ss.submitted_at, ss.pending_changes
     FROM meetings mt
     LEFT JOIN subgroup_cashbook_submissions ss
       ON ss.meeting_id = mt.id AND ss.subgroup_code = ?
     WHERE mt.meeting_date >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY)
     ORDER BY mt.meeting_date DESC LIMIT 24`,
    [subgroupCode]
  );
  res.render('subgroups/cashbooks', {
    title: `Subgroup ${subgroupCode} cashbooks`,
    meetings,
    subgroupCode,
    reportDate: new Date().toISOString().slice(0, 10)
  });
}));

app.get('/subgroup/cashbook/report.pdf', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  const period = getReportPeriod(req.query.period, req.query.date);
  const [members] = await db.pool.execute(
    `SELECT m.full_name, COALESCE(records.fine, 0) AS fine, COALESCE(records.social, 0) AS social,
       COALESCE(records.savings, 0) AS savings, COALESCE(records.loan_return, 0) AS loan_return,
       COALESCE(disbursements.loan_taken, 0) AS loan_taken
     FROM members m
     LEFT JOIN (
       SELECT r.member_id, SUM(r.fine) AS fine, SUM(r.social) AS social,
         SUM(r.savings) AS savings, SUM(r.loan_return) AS loan_return
       FROM subgroup_member_meeting_records r JOIN meetings mt ON mt.id = r.meeting_id
       WHERE r.subgroup_code = ? AND DATE(mt.meeting_date) BETWEEN ? AND ?
       GROUP BY r.member_id
     ) records ON records.member_id = m.id
     LEFT JOIN (
       SELECT l.member_id, SUM(t.amount) AS loan_taken
       FROM transactions t JOIN loans l ON l.id = t.related_id
       JOIN members loan_member ON loan_member.id = l.member_id
       JOIN meetings mt ON mt.id = t.meeting_id
       WHERE loan_member.subgroup_code = ? AND t.transaction_type = 'loan_disbursement'
         AND t.is_voided = FALSE AND DATE(mt.meeting_date) BETWEEN ? AND ?
       GROUP BY l.member_id
     ) disbursements ON disbursements.member_id = m.id
     WHERE records.member_id IS NOT NULL OR disbursements.member_id IS NOT NULL
     ORDER BY m.full_name`,
    [subgroupCode, period.start, period.end, subgroupCode, period.start, period.end]
  );
  const totals = members.reduce((result, member) => ({
    fine: result.fine + toCents(member.fine),
    social: result.social + toCents(member.social),
    savings: result.savings + toCents(member.savings),
    loan_return: result.loan_return + toCents(member.loan_return),
    loan_taken: result.loan_taken + toCents(member.loan_taken)
  }), { fine: 0, social: 0, savings: 0, loan_return: 0, loan_taken: 0 });
  sendPdfTable(
    res,
    `subgroup-${subgroupCode}-${period.filename}.pdf`,
    `Subgroup ${subgroupCode} transactions`,
    `${period.label} · ${period.start} to ${period.end} · Member-level records`,
    [
      { label: 'Member', width: 220 }, { label: 'Fine', width: 75 },
      { label: 'Social', width: 75 }, { label: 'Savings', width: 80 },
      { label: 'Loan return', width: 90 }, { label: 'Loan taken', width: 90 }
    ],
    members.map((member) => [
      member.full_name, Number(member.fine).toFixed(2), Number(member.social).toFixed(2),
      Number(member.savings).toFixed(2), Number(member.loan_return).toFixed(2),
      Number(member.loan_taken).toFixed(2)
    ]),
    [[
      'SUBGROUP TOTAL', fromCents(totals.fine), fromCents(totals.social),
      fromCents(totals.savings), fromCents(totals.loan_return), fromCents(totals.loan_taken)
    ]]
  );
}));

app.get('/subgroup/cashbook/:id/report.pdf', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  const [meetings] = await db.pool.execute(
    'SELECT id, title, meeting_date, DATE(meeting_date) AS meeting_day FROM meetings WHERE id = ?',
    [meetingId]
  );
  if (!meetings.length) return res.status(404).render('error', { title: 'Meeting not found', message: 'That meeting could not be found.' });
  const [members] = await db.pool.execute(
    `SELECT m.full_name, COALESCE(r.fine, 0) AS fine, COALESCE(r.social, 0) AS social,
       COALESCE(r.savings, 0) AS savings, COALESCE(r.loan_return, 0) AS loan_return,
       COALESCE((SELECT SUM(t.amount) FROM transactions t JOIN loans l ON l.id = t.related_id
         WHERE l.member_id = m.id AND t.meeting_id = ? AND t.transaction_type = 'loan_disbursement'
           AND t.is_voided = FALSE), 0) AS loan_taken
     FROM members m
     LEFT JOIN subgroup_member_meeting_records r
       ON r.member_id = m.id AND r.meeting_id = ? AND r.subgroup_code = ?
     WHERE m.subgroup_code = ?
       AND (m.status = 'active' OR r.id IS NOT NULL
         OR EXISTS (SELECT 1 FROM transactions t JOIN loans l ON l.id = t.related_id
           WHERE l.member_id = m.id AND t.meeting_id = ? AND t.transaction_type = 'loan_disbursement'
             AND t.is_voided = FALSE))
     ORDER BY m.full_name`,
    [meetingId, meetingId, subgroupCode, subgroupCode, meetingId]
  );
  const [submissions] = await db.pool.execute(
    `SELECT submitted_at, pending_changes FROM subgroup_cashbook_submissions
     WHERE meeting_id = ? AND subgroup_code = ?`,
    [meetingId, subgroupCode]
  );
  const sums = members.reduce((totals, member) => ({
    fine: totals.fine + toCents(member.fine),
    social: totals.social + toCents(member.social),
    savings: totals.savings + toCents(member.savings),
    loan_return: totals.loan_return + toCents(member.loan_return),
    loan_taken: totals.loan_taken + toCents(member.loan_taken)
  }), { fine: 0, social: 0, savings: 0, loan_return: 0, loan_taken: 0 });
  const meeting = meetings[0];
  const submission = submissions[0];
  const state = submission && submission.submitted_at
    ? submission.pending_changes ? 'Submitted report has newer unsent changes.' : 'Submitted totals are up to date.'
    : 'Draft report; totals have not been submitted.';
  sendPdfTable(
    res,
    `subgroup-${subgroupCode}-meeting-${meetingId}.pdf`,
    `Subgroup ${subgroupCode} weekly transactions`,
    `${meeting.title} · ${new Date(meeting.meeting_date).toLocaleDateString('en', { dateStyle: 'long' })} · ${state}`,
    [
      { label: 'Member', width: 220 }, { label: 'Fine', width: 75 },
      { label: 'Social', width: 75 }, { label: 'Savings', width: 80 },
      { label: 'Loan return', width: 90 }, { label: 'Loan taken', width: 90 }
    ],
    members.map((member) => [
      member.full_name, Number(member.fine).toFixed(2), Number(member.social).toFixed(2),
      Number(member.savings).toFixed(2), Number(member.loan_return).toFixed(2),
      Number(member.loan_taken).toFixed(2)
    ]),
    [[
      'SUBGROUP TOTAL', fromCents(sums.fine), fromCents(sums.social), fromCents(sums.savings),
      fromCents(sums.loan_return), fromCents(sums.loan_taken)
    ]]
  );
}));

app.get('/subgroup/meetings', allowRoles('subgroup_secretary'), asyncRoute(async (req, res) => {
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  await ensureWeeklyMeetings();
  const [meetings] = await db.pool.execute(
    `SELECT mt.id, mt.title, mt.meeting_date, smn.updated_at,
       (SELECT COUNT(*) FROM attendance a
        JOIN members m ON m.id = a.member_id
        WHERE a.meeting_id = mt.id AND a.status = 'present'
          AND m.subgroup_code = ?) AS attendees
     FROM meetings mt
     LEFT JOIN subgroup_meeting_notes smn
       ON smn.meeting_id = mt.id AND smn.subgroup_code = ?
     WHERE mt.meeting_date >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY)
     ORDER BY mt.meeting_date DESC LIMIT 24`,
    [subgroupCode, subgroupCode]
  );
  res.render('subgroups/meetings', { title: `Subgroup ${subgroupCode} meetings`, meetings, subgroupCode });
}));

app.get('/subgroup/meetings/:id', allowRoles('subgroup_secretary'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  const [meetings] = await db.pool.execute('SELECT id, title, meeting_date FROM meetings WHERE id = ?', [meetingId]);
  if (!meetings.length) return res.status(404).render('error', { title: 'Meeting not found', message: 'That meeting could not be found.' });
  const [[note]] = await db.pool.execute(
    'SELECT notes FROM subgroup_meeting_notes WHERE meeting_id = ? AND subgroup_code = ?',
    [meetingId, subgroupCode]
  );
  const [members] = await db.pool.execute(
    `SELECT m.id, m.full_name, a.status
     FROM members m LEFT JOIN attendance a ON a.member_id = m.id AND a.meeting_id = ?
     WHERE m.subgroup_code = ? AND m.status = 'active'
     ORDER BY m.full_name`,
    [meetingId, subgroupCode]
  );
  res.render('subgroups/meeting', {
    title: `Subgroup ${subgroupCode} attendance`, meeting: meetings[0],
    members, notes: note ? note.notes : '', subgroupCode
  });
}));

app.post('/subgroup/meetings/:id', allowRoles('subgroup_secretary'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  const notes = typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 10000) : '';
  await transaction(async (connection) => {
    const [meetings] = await connection.execute('SELECT id FROM meetings WHERE id = ? FOR UPDATE', [meetingId]);
    if (!meetings.length) throw Object.assign(new Error('That meeting could not be found.'), { status: 404 });
    const [members] = await connection.execute(
      `SELECT id FROM members
       WHERE subgroup_code = ? AND status = 'active' ORDER BY id FOR UPDATE`,
      [subgroupCode]
    );
    const attendance = req.body.attendance && typeof req.body.attendance === 'object'
      ? req.body.attendance : {};
    for (const member of members) {
      const submittedStatus = attendance[String(member.id)];
      const status = ['present', 'absent', 'excused'].includes(submittedStatus) ? submittedStatus : 'absent';
      await connection.execute(
        `INSERT INTO attendance (meeting_id, member_id, status) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status)`,
        [meetingId, member.id, status]
      );
    }
    await connection.execute(
      `INSERT INTO subgroup_meeting_notes (meeting_id, subgroup_code, notes, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE notes = VALUES(notes), updated_by = VALUES(updated_by)`,
      [meetingId, subgroupCode, notes || null, req.session.user.id]
    );
  });
  redirectNotice(res, `/subgroup/meetings/${meetingId}`, 'Subgroup attendance and meeting notes saved.');
}));

app.get('/subgroup/cashbook/:id', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  const [meetings] = await db.pool.execute(
    'SELECT id, title, meeting_date, DATE(meeting_date) AS meeting_day FROM meetings WHERE id = ?',
    [meetingId]
  );
  if (!meetings.length) return res.status(404).render('error', { title: 'Meeting not found', message: 'That meeting could not be found.' });
  const [submissions] = await db.pool.execute(
    `SELECT fines, socials, savings, loan_return, loan_taken, submitted_at, pending_changes, updated_at
     FROM subgroup_cashbook_submissions WHERE meeting_id = ? AND subgroup_code = ?`,
    [meetingId, subgroupCode]
  );
  const [members] = await db.pool.execute(
    `SELECT m.id, m.full_name, COALESCE(r.fine, 0) AS fine, COALESCE(r.social, 0) AS social,
       COALESCE(r.savings, 0) AS savings, COALESCE(r.loan_return, 0) AS loan_return,
       COALESCE((SELECT SUM(t.amount) FROM transactions t
         JOIN loans l ON l.id = t.related_id
         WHERE l.member_id = m.id AND t.meeting_id = ?
           AND t.transaction_type = 'loan_disbursement' AND t.is_voided = FALSE), 0) AS loan_taken
     FROM members m
     LEFT JOIN subgroup_member_meeting_records r
       ON r.member_id = m.id AND r.meeting_id = ? AND r.subgroup_code = ?
     WHERE m.subgroup_code = ?
       AND (m.status = 'active' OR r.id IS NOT NULL
         OR EXISTS (SELECT 1 FROM transactions t JOIN loans l ON l.id = t.related_id
           WHERE l.member_id = m.id AND t.meeting_id = ? AND t.transaction_type = 'loan_disbursement'
             AND t.is_voided = FALSE))
     ORDER BY m.full_name`,
    [meetingId, meetingId, subgroupCode, subgroupCode, meetingId]
  );
  const totals = await subgroupMeetingTotals(db.pool, meetingId, subgroupCode);
  res.render('subgroups/cashbook', {
    title: `Subgroup ${subgroupCode} collection`,
    meeting: meetings[0],
    subgroupCode,
    submission: submissions[0] || null,
    members,
    totals,
    reportDate: meetings[0].meeting_day
  });
}));

async function saveSubgroupMemberMeetingRecord(req, clearRecord = false) {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const memberId = positiveId(req.params.memberId, 'Member');
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  const values = {
    fine: clearRecord ? '0.00' : positiveMoney(req.body.fine || '0', 'Fine'),
    social: clearRecord ? '0.00' : positiveMoney(req.body.social || '0', 'Social'),
    savings: clearRecord ? '0.00' : positiveMoney(req.body.savings || '0', 'Savings'),
    loan_return: clearRecord ? '0.00' : positiveMoney(req.body.loan_return || '0', 'Loan return')
  };
  return transaction(async (connection) => {
    const [meetings] = await connection.execute(
      `SELECT id, DATE_FORMAT(meeting_date, '%e %b %Y') AS meeting_date_label
       FROM meetings WHERE id = ? FOR UPDATE`,
      [meetingId]
    );
    if (!meetings.length) throw Object.assign(new Error('That meeting could not be found.'), { status: 404 });
    const [memberRows] = await connection.execute(
      `SELECT id, full_name, phone, status FROM members
       WHERE id = ? AND subgroup_code = ? FOR UPDATE`,
      [memberId, subgroupCode]
    );
    const member = memberRows[0];
    if (!member) throw Object.assign(new Error('This member is not in your subgroup or is inactive.'), { status: 404 });
    const [previous] = await connection.execute(
      `SELECT fine, social, savings, loan_return
       FROM subgroup_member_meeting_records
       WHERE meeting_id = ? AND member_id = ? AND subgroup_code = ? FOR UPDATE`,
      [meetingId, memberId, subgroupCode]
    );
    if (member.status !== 'active' && !previous.length && !clearRecord) {
      throw new Error('Inactive members can only have existing meeting records corrected.');
    }
    if (previous.length) {
      await connection.execute(
        `INSERT INTO subgroup_member_meeting_revisions
         (meeting_id, member_id, subgroup_code, fine, social, savings, loan_return, changed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meetingId, memberId, subgroupCode, previous[0].fine, previous[0].social,
          previous[0].savings, previous[0].loan_return, req.session.user.id
        ]
      );
    }
    await connection.execute(
      `INSERT INTO subgroup_member_meeting_records
       (meeting_id, member_id, subgroup_code, fine, social, savings, loan_return, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE fine = VALUES(fine), social = VALUES(social),
         savings = VALUES(savings), loan_return = VALUES(loan_return),
         updated_by = VALUES(updated_by)`,
      [
        meetingId, memberId, subgroupCode, values.fine, values.social,
        values.savings, values.loan_return, req.session.user.id
      ]
    );
    for (const category of ['fine', 'social', 'savings']) {
      await syncMemberContribution(
        connection, meetingId, memberId, category, values[category],
        member.full_name, req.session.user.id
      );
    }
    await syncMemberLoanReturn(
      connection, meetingId, memberId, values.loan_return, req.session.user.id
    );
    const [[loanTaken]] = await connection.execute(
      `SELECT COALESCE(SUM(t.amount), 0) AS amount
       FROM transactions t
       JOIN loans l ON l.id = t.related_id
       WHERE l.member_id = ? AND t.meeting_id = ?
         AND t.transaction_type = 'loan_disbursement' AND t.is_voided = FALSE`,
      [memberId, meetingId]
    );
    if (clearRecord) {
      await connection.execute(
        `DELETE FROM subgroup_member_meeting_records
         WHERE meeting_id = ? AND member_id = ? AND subgroup_code = ?`,
        [meetingId, memberId, subgroupCode]
      );
    }
    await connection.execute(
      `INSERT INTO subgroup_cashbook_submissions (meeting_id, subgroup_code, pending_changes)
       VALUES (?, ?, TRUE)
       ON DUPLICATE KEY UPDATE pending_changes = TRUE`,
      [meetingId, subgroupCode]
    );
    await recalculateCashbookCarryForwards(connection);
    return {
      memberName: member.full_name,
      phone: member.phone,
      meetingDate: meetings[0].meeting_date_label,
      subgroupCode,
      fine: values.fine,
      social: values.social,
      savings: values.savings,
      loanReturn: values.loan_return,
      loanTaken: loanTaken.amount
    };
  });
}

app.post('/subgroup/cashbook/:id/member/:memberId', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const record = await saveSubgroupMemberMeetingRecord(req);
  try {
    const body = formatMemberContributionSms({ ...record, currency: res.locals.currency });
    await sendGalatextSms({ to: record.phone, body });
  } catch (error) {
    console.error('Member contribution SMS failed:', error.message);
    return redirectNotice(
      res,
      `/subgroup/cashbook/${meetingId}`,
      `Records saved for ${record.memberName}, but the SMS notification was not sent: ${error.message}`,
      'error'
    );
  }
  redirectNotice(res, `/subgroup/cashbook/${meetingId}`, 'Member financial records saved and SMS notification submitted to Galatext.');
}));

app.post('/subgroup/cashbook/:id/member/:memberId/delete', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const record = await saveSubgroupMemberMeetingRecord(req, true);
  try {
    const body = formatMemberContributionSms({ ...record, currency: res.locals.currency });
    await sendGalatextSms({ to: record.phone, body });
  } catch (error) {
    console.error('Member contribution SMS failed after record deletion:', error.message);
    return redirectNotice(
      res,
      `/subgroup/cashbook/${meetingId}`,
      `Records cleared for ${record.memberName}, but the SMS notification was not sent: ${error.message}`,
      'error'
    );
  }
  redirectNotice(res, `/subgroup/cashbook/${meetingId}`, 'Member records cleared and SMS notification submitted to Galatext. The change is in the audit history and report totals are marked for resubmission.');
}));

app.post('/subgroup/cashbook/:id/submit', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  await transaction(async (connection) => {
    const [meetings] = await connection.execute('SELECT id FROM meetings WHERE id = ? FOR UPDATE', [meetingId]);
    if (!meetings.length) throw Object.assign(new Error('That meeting could not be found.'), { status: 404 });
    const totals = await subgroupMeetingTotals(connection, meetingId, subgroupCode);
    const [previous] = await connection.execute(
      `SELECT fines, socials, savings, loan_return, loan_taken, submitted_by
       FROM subgroup_cashbook_submissions
       WHERE meeting_id = ? AND subgroup_code = ? FOR UPDATE`,
      [meetingId, subgroupCode]
    );
    if (previous.length) {
      await connection.execute(
        `INSERT INTO subgroup_cashbook_revisions
         (meeting_id, subgroup_code, fines, socials, savings, loan_return, loan_taken, submitted_by, revised_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meetingId, subgroupCode, previous[0].fines, previous[0].socials,
          previous[0].savings, previous[0].loan_return, previous[0].loan_taken,
          previous[0].submitted_by, req.session.user.id
        ]
      );
    }
    await connection.execute(
      `INSERT INTO subgroup_cashbook_submissions
       (meeting_id, subgroup_code, fines, socials, savings, loan_return, loan_taken, submitted_by, submitted_at, pending_changes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), FALSE)
       ON DUPLICATE KEY UPDATE fines = VALUES(fines), socials = VALUES(socials),
         savings = VALUES(savings), loan_return = VALUES(loan_return),
         loan_taken = VALUES(loan_taken), submitted_by = VALUES(submitted_by),
         submitted_at = NOW(), pending_changes = FALSE`,
      [
        meetingId, subgroupCode, totals.fine, totals.social, totals.savings,
        totals.loan_return, totals.loan_taken, req.session.user.id
      ]
    );
    await recalculateCashbookCarryForwards(connection);
  });
  redirectNotice(res, `/subgroup/cashbook/${meetingId}`, `Subgroup ${subgroupCode} totals submitted to the Financial Secretary.`);
}));

app.get('/subgroup/loans', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  await ensureWeeklyMeetings();
  const [loans] = await db.pool.execute(
    `SELECT l.*, m.full_name,
       COALESCE((SELECT SUM(lr.amount) FROM loan_repayments lr
         JOIN transactions t ON t.id = lr.transaction_id
         WHERE lr.loan_id = l.id AND t.is_voided = FALSE), 0) AS repaid
     FROM loans l JOIN members m ON m.id = l.member_id
     WHERE m.subgroup_code = ?
     ORDER BY FIELD(l.status, 'pending', 'approved', 'active', 'rejected', 'repaid'), l.application_date DESC`,
    [subgroupCode]
  );
  const [members] = await db.pool.execute(
    `SELECT id, full_name FROM members
     WHERE subgroup_code = ? AND status = 'active' ORDER BY full_name`,
    [subgroupCode]
  );
  const [meetings] = await db.pool.execute(
    'SELECT id, title, meeting_date FROM meetings WHERE meeting_date >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY) ORDER BY meeting_date DESC LIMIT 20'
  );
  res.render('subgroups/loans', {
    title: `Subgroup ${subgroupCode} loans`, loans, members, meetings, subgroupCode,
    defaultRate: await setting('interest_rate', '12.0000'),
    defaultTerm: await setting('default_loan_term_months', '12')
  });
}));

app.post('/subgroup/loans', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  const memberId = positiveId(req.body.member_id, 'Member');
  const amount = nonZeroMoney(req.body.amount, 'Loan amount');
  const purpose = requiredText(req.body.purpose, 'Loan purpose', 500);
  const interestRate = Number(await setting('interest_rate', '12.0000'));
  const termMonths = positiveInteger(req.body.term_months || await setting('default_loan_term_months', '12'), 'Loan term');
  await transaction(async (connection) => {
    const [members] = await connection.execute(
      `SELECT id FROM members
       WHERE id = ? AND subgroup_code = ? AND status = 'active' FOR UPDATE`,
      [memberId, subgroupCode]
    );
    if (!members.length) throw new Error('Choose an active member in your subgroup.');
    await connection.execute(
      `INSERT INTO loans
       (member_id, amount, interest_rate, term_months, application_date, purpose)
       VALUES (?, ?, ?, ?, CURRENT_DATE, ?)`,
      [memberId, amount, interestRate, termMonths, purpose]
    );
  });
  redirectNotice(res, '/subgroup/loans', 'Subgroup loan application recorded.');
}));

app.post('/subgroup/loans/:id/review', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  if (!['approved', 'rejected'].includes(req.body.decision)) throw new Error('Choose approve or reject.');
  await transaction(async (connection) => {
    const [loans] = await connection.execute(
      `SELECT l.id, l.status FROM loans l
       JOIN members m ON m.id = l.member_id
       WHERE l.id = ? AND m.subgroup_code = ? FOR UPDATE`,
      [req.params.id, subgroupCode]
    );
    if (!loans.length || loans[0].status !== 'pending') {
      throw new Error('Only pending applications in your subgroup can be reviewed.');
    }
    await connection.execute(
      'UPDATE loans SET status = ?, approval_date = CURRENT_DATE, approved_by = ? WHERE id = ?',
      [req.body.decision, req.session.user.id, req.params.id]
    );
  });
  redirectNotice(res, '/subgroup/loans', `Subgroup loan application ${req.body.decision}.`);
}));

app.post('/subgroup/loans/:id/disburse', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const subgroupCode = req.session.user.subgroupCode;
  if (!subgroupCodes.includes(subgroupCode)) throw new Error('This account is not assigned to a subgroup.');
  const meetingId = positiveId(req.body.meeting_id, 'Meeting');
  await transaction((connection) =>
    disburseLoan(connection, req.params.id, meetingId, req.session.user.id, subgroupCode)
  );
  redirectNotice(res, '/subgroup/loans', 'Subgroup loan disbursed and repayment schedule created.');
}));

app.get('/subgroup/loans/:id/edit', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const subgroupCode = req.session.user.subgroupCode;
  const [loans] = await db.pool.execute(
    `SELECT l.* FROM loans l JOIN members m ON m.id = l.member_id
     WHERE l.id = ? AND m.subgroup_code = ?
       AND l.status IN ('pending', 'approved') AND l.disbursed_at IS NULL`,
    [req.params.id, subgroupCode]
  );
  if (!loans.length) return res.status(404).render('error', { title: 'Loan not found', message: 'That editable loan could not be found in your subgroup.' });
  const [members] = await db.pool.execute(
    'SELECT id, full_name, status FROM members WHERE subgroup_code = ? ORDER BY full_name',
    [subgroupCode]
  );
  res.render('finance/loan-form', {
    title: 'Update loan', loan: loans[0], members,
    defaultRate: await setting('interest_rate', '12.0000'),
    defaultTerm: await setting('default_loan_term_months', '12'),
    subgroup: true
  });
}));

app.get('/subgroup/loans/:id/schedule', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const subgroupCode = req.session.user.subgroupCode;
  const [loans] = await db.pool.execute(
    `SELECT l.id, l.status, l.balance, m.full_name
     FROM loans l JOIN members m ON m.id = l.member_id
     WHERE l.id = ? AND m.subgroup_code = ?`,
    [req.params.id, subgroupCode]
  );
  if (!loans.length) return res.status(404).render('error', { title: 'Loan not found', message: 'That loan could not be found in your subgroup.' });
  const [schedule] = await db.pool.execute(
    'SELECT installment_number, due_date, amount_due, amount_paid FROM repayment_schedule WHERE loan_id = ? ORDER BY installment_number',
    [req.params.id]
  );
  res.render('finance/schedule', { title: `Loan #${req.params.id} schedule`, loan: loans[0], schedule, subgroup: true });
}));

app.post('/subgroup/loans/:id/edit', allowRoles('subgroup_chairperson'), asyncRoute(async (req, res) => {
  const subgroupCode = req.session.user.subgroupCode;
  const memberId = positiveId(req.body.member_id, 'Member');
  const amount = nonZeroMoney(req.body.amount, 'Loan amount');
  const purpose = requiredText(req.body.purpose, 'Loan purpose', 500);
  const termMonths = positiveInteger(req.body.term_months, 'Loan term');
  let wasApproved = false;
  await transaction(async (connection) => {
    const [loans] = await connection.execute(
      `SELECT l.status FROM loans l JOIN members m ON m.id = l.member_id
       WHERE l.id = ? AND m.subgroup_code = ?
         AND l.status IN ('pending', 'approved') AND l.disbursed_at IS NULL FOR UPDATE`,
      [req.params.id, subgroupCode]
    );
    if (!loans.length) throw new Error('Only pending or approved undistributed loans in your subgroup can be edited.');
    const [members] = await connection.execute(
      `SELECT id FROM members
       WHERE id = ? AND subgroup_code = ? AND status = 'active' FOR UPDATE`,
      [memberId, subgroupCode]
    );
    if (!members.length) throw new Error('Choose an active member in your subgroup.');
    wasApproved = loans[0].status === 'approved';
    await connection.execute(
      `UPDATE loans SET member_id = ?, amount = ?, term_months = ?, purpose = ?,
       status = 'pending', approval_date = NULL, approved_by = NULL WHERE id = ?`,
      [memberId, amount, termMonths, purpose, req.params.id]
    );
  });
  redirectNotice(res, '/subgroup/loans', wasApproved
    ? 'Loan updated; it must be approved again before disbursement.'
    : 'Subgroup loan application updated.');
}));

app.get('/meetings', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  await ensureWeeklyMeetings();
  const [meetings] = await db.pool.execute(
    `SELECT mt.id, mt.title, mt.meeting_date, mt.description,
      (SELECT COUNT(*) FROM attendance a WHERE a.meeting_id = mt.id AND a.status = 'present') AS attendees
     FROM meetings mt ORDER BY mt.meeting_date DESC`
  );
  res.render('meetings/index', { title: 'Meetings', meetings });
}));

app.get('/meetings/new', allowRoles('chairperson', 'secretary'), (req, res) => {
  res.render('meetings/form', {
    title: 'Schedule meeting',
    meeting: null,
    defaultMeetingDate: meetingDateTime(nextThursdayDate())
  });
});

app.post('/meetings', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  const title = requiredText(req.body.title, 'Meeting title', 180);
  const meetingDate = typeof req.body.meeting_date === 'string' ? req.body.meeting_date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(meetingDate) || Number.isNaN(Date.parse(meetingDate))) {
    throw new Error('Enter a valid meeting date and time.');
  }
  const description = typeof req.body.description === 'string' ? req.body.description.trim().slice(0, 5000) : '';
  const [result] = await db.pool.execute(
    'INSERT INTO meetings (title, meeting_date, description, created_by) VALUES (?, ?, ?, ?)',
    [title, meetingDate.replace('T', ' ') + ':00', description || null, req.session.user.id]
  );
  redirectNotice(res, `/meetings/${result.insertId}`, 'Meeting scheduled.');
}));

app.get('/meetings/:id', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  const [meetings] = await db.pool.execute('SELECT * FROM meetings WHERE id = ?', [req.params.id]);
  if (!meetings.length) return res.status(404).render('error', { title: 'Meeting not found', message: 'That meeting could not be found.' });
  const [members] = await db.pool.execute(
    `SELECT m.id, m.full_name, a.status FROM members m
     LEFT JOIN attendance a ON a.member_id = m.id AND a.meeting_id = ?
     WHERE m.status = 'active' ORDER BY m.full_name`,
    [req.params.id]
  );
  res.render('meetings/show', { title: meetings[0].title, meeting: meetings[0], members });
}));

app.post('/meetings/:id/records', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  const minutes = typeof req.body.minutes === 'string' ? req.body.minutes.trim().slice(0, 20000) : '';
  await transaction(async (connection) => {
    const [meeting] = await connection.execute('SELECT id FROM meetings WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!meeting.length) throw Object.assign(new Error('That meeting could not be found.'), { status: 404 });
    await connection.execute('UPDATE meetings SET minutes = ? WHERE id = ?', [minutes || null, req.params.id]);
    const submitted = req.body.attendance && typeof req.body.attendance === 'object' ? req.body.attendance : {};
    for (const [memberId, status] of Object.entries(submitted)) {
      if (!/^\d+$/.test(memberId) || !['present', 'absent', 'excused'].includes(status)) continue;
      await connection.execute(
        `INSERT INTO attendance (meeting_id, member_id, status) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status)`,
        [req.params.id, memberId, status]
      );
    }
  });
  redirectNotice(res, `/meetings/${req.params.id}`, 'Minutes and attendance saved.');
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDirectory),
    filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`)
  }),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowed = new Set([
      'application/pdf', 'image/jpeg', 'image/png',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword', 'text/plain'
    ]);
    if (!allowed.has(file.mimetype)) return callback(new Error('Choose a PDF, Word document, JPG, PNG, or plain text file.'));
    callback(null, true);
  }
});

app.get('/documents', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  const [documents] = await db.pool.execute(
    `SELECT d.id, d.title, d.original_name, d.mime_type, d.file_size, d.created_at, u.full_name AS uploader
     FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
     ORDER BY d.created_at DESC`
  );
  res.render('documents/index', { title: 'Documents', documents });
}));

app.post('/documents', allowRoles('chairperson', 'secretary'), (req, res, next) => {
  upload.single('document')(req, res, (error) => {
    if (error) return res.status(400).render('error', { title: 'Upload could not be completed', message: error.message });
    if (!validCsrfToken(req, req.body && req.body._csrf)) {
      if (req.file) fs.unlink(req.file.path, (unlinkError) => {
        if (unlinkError) console.error('Unable to remove rejected document upload:', unlinkError);
      });
      return res.status(403).render('error', {
        title: 'Page expired',
        message: 'This form could not be verified. Go back, refresh the page, and try again.'
      });
    }
    next();
  });
}, asyncRoute(async (req, res) => {
  if (!req.file) throw new Error('Select a document to upload.');
  try {
    const title = requiredText(req.body.title, 'Document title', 180);
    await db.pool.execute(
      'INSERT INTO documents (title, original_name, stored_name, mime_type, file_size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
      [title, path.basename(req.file.originalname).slice(0, 255), req.file.filename, req.file.mimetype, req.file.size, req.session.user.id]
    );
  } catch (error) {
    fs.unlink(req.file.path, (unlinkError) => {
      if (unlinkError) console.error('Unable to remove unregistered document:', unlinkError);
    });
    throw error;
  }
  redirectNotice(res, '/documents', 'Document uploaded.');
}));

app.get('/documents/:id/download', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  const [documents] = await db.pool.execute('SELECT * FROM documents WHERE id = ?', [req.params.id]);
  if (!documents.length) return res.status(404).render('error', { title: 'Document not found', message: 'That document could not be found.' });
  const filePath = path.resolve(uploadDirectory, path.basename(documents[0].stored_name));
  if (!filePath.startsWith(`${uploadDirectory}${path.sep}`)) throw new Error('Invalid document storage path.');
  res.download(filePath, documents[0].original_name, {
    headers: { 'Content-Type': 'application/octet-stream' }
  }, (error) => {
    if (error && !res.headersSent) res.status(error.statusCode || 404).render('error', {
      title: 'Download failed', message: 'The document file is not available on the server.'
    });
  });
}));

app.post('/documents/:id/delete', allowRoles('chairperson', 'secretary'), asyncRoute(async (req, res) => {
  const [documents] = await db.pool.execute('SELECT stored_name FROM documents WHERE id = ?', [req.params.id]);
  if (!documents.length) return res.status(404).render('error', { title: 'Document not found', message: 'That document could not be found.' });
  await db.pool.execute('DELETE FROM documents WHERE id = ?', [req.params.id]);
  const filePath = path.resolve(uploadDirectory, path.basename(documents[0].stored_name));
  fs.unlink(filePath, (error) => {
    if (error && error.code !== 'ENOENT') console.error('Unable to remove document file:', error);
  });
  redirectNotice(res, '/documents', 'Document deleted.');
}));

app.get('/finance/contributions', allowRoles('chairperson', 'financial_secretary', 'treasurer'), asyncRoute(async (req, res) => {
  await ensureWeeklyMeetings();
  const [configRows] = await db.pool.execute(
    'SELECT opening_balance, effective_from FROM subgroup_cashbook_config WHERE id = 1'
  );
  if (!configRows.length) throw new Error('The subgroup cashbook opening balance has not been configured.');
  const [allMeetings] = await db.pool.execute(
    'SELECT id, title, meeting_date FROM meetings WHERE DATE(meeting_date) >= ? ORDER BY meeting_date, id',
    [configRows[0].effective_from]
  );
  const [submissions] = await db.pool.execute(
    `SELECT meeting_id, subgroup_code, fines, socials, savings, loan_return, loan_taken,
       submitted_at, pending_changes, updated_at
     FROM subgroup_cashbook_submissions WHERE submitted_at IS NOT NULL
     ORDER BY meeting_id, subgroup_code`
  );
  const meetings = createSubgroupCashbookSummaries(
    allMeetings,
    submissions,
    configRows[0].opening_balance
  ).slice(-24).reverse();
  res.render('finance/contributions', {
    title: 'Meeting cashbooks',
    meetings,
    reportDate: new Date().toISOString().slice(0, 10)
  });
}));

app.get('/finance/contributions/report.pdf', allowRoles('chairperson', 'financial_secretary', 'treasurer'), asyncRoute(async (req, res) => {
  const period = getReportPeriod(req.query.period, req.query.date);
  const [configRows] = await db.pool.execute(
    'SELECT opening_balance, effective_from FROM subgroup_cashbook_config WHERE id = 1'
  );
  if (!configRows.length) throw new Error('The subgroup cashbook opening balance has not been configured.');
  const [allMeetings] = await db.pool.execute(
    `SELECT id, title, meeting_date, DATE(meeting_date) AS meeting_day FROM meetings
     WHERE DATE(meeting_date) >= ? AND DATE(meeting_date) <= ?
     ORDER BY meeting_date, id`,
    [configRows[0].effective_from, period.end]
  );
  const periodMeetings = allMeetings.filter((meeting) => {
    const date = meeting.meeting_day;
    return date >= period.start && date <= period.end;
  });
  let submissions = [];
  if (allMeetings.length) {
    const placeholders = allMeetings.map(() => '?').join(', ');
    [submissions] = await db.pool.execute(
      `SELECT meeting_id, subgroup_code, fines, socials, savings, loan_return,
         loan_taken, submitted_at, pending_changes, updated_at
       FROM subgroup_cashbook_submissions
       WHERE submitted_at IS NOT NULL AND meeting_id IN (${placeholders})
       ORDER BY meeting_id, subgroup_code`,
      allMeetings.map((meeting) => meeting.id)
    );
  }
  const summaries = createSubgroupCashbookSummaries(
    allMeetings, submissions, configRows[0].opening_balance
  );
  const summaryByMeeting = new Map(summaries.map((meeting) => [String(meeting.id), meeting]));
  const reports = periodMeetings.map((meeting) => summaryByMeeting.get(String(meeting.id)));
  const priorReports = summaries.filter((meeting) => {
    const date = meeting.meeting_day;
    return date < period.start;
  });
  const initialBalance = Number(configRows[0].opening_balance);
  const openingBalance = reports.length
    ? reports[0].summary.opening_balance
    : priorReports.length
      ? priorReports[priorReports.length - 1].summary.closing_balance
      : initialBalance.toFixed(2);
  const closingBalance = reports.length
    ? reports[reports.length - 1].summary.closing_balance
    : openingBalance;
  const reportRows = subgroupCodes.map((code) => {
    const subgroupReports = reports.map((meeting) =>
      meeting.subgroups.find((subgroup) => subgroup.code === code));
    const totals = subgroupReports.reduce((sum, subgroup) => ({
      fines: sum.fines + toCents(subgroup.fines),
      socials: sum.socials + toCents(subgroup.socials),
      savings: sum.savings + toCents(subgroup.savings),
      loan_return: sum.loan_return + toCents(subgroup.loan_return),
      loan_taken: sum.loan_taken + toCents(subgroup.loan_taken)
    }), { fines: 0, socials: 0, savings: 0, loan_return: 0, loan_taken: 0 });
    const currentCount = subgroupReports.filter((subgroup) => subgroup.submitted && !subgroup.pendingChanges).length;
    const pending = subgroupReports.some((subgroup) => subgroup.pendingChanges);
    const status = !subgroupReports.length ? 'No meetings'
      : pending ? `Changes pending · ${currentCount}/${subgroupReports.length} current`
        : currentCount === subgroupReports.length ? `Submitted · ${currentCount}/${subgroupReports.length}`
          : `Partial · ${currentCount}/${subgroupReports.length} current`;
    return {
      code,
      status,
      ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, fromCents(value)]))
    };
  });
  const groupTotals = reportRows.reduce((sum, subgroup) => ({
    fines: sum.fines + toCents(subgroup.fines),
    socials: sum.socials + toCents(subgroup.socials),
    savings: sum.savings + toCents(subgroup.savings),
    loan_return: sum.loan_return + toCents(subgroup.loan_return),
    loan_taken: sum.loan_taken + toCents(subgroup.loan_taken)
  }), { fines: 0, socials: 0, savings: 0, loan_return: 0, loan_taken: 0 });
  const formatMoney = (value) => `${res.locals.currency} ${Number(value).toFixed(2)}`;
  const periodSubheading = `${period.label} · ${period.start} to ${period.end} · ${periodMeetings.length} meeting(s)`;
  sendPdfTable(
    res,
    `group-transactions-${period.filename}.pdf`,
    'Weekly group transactions',
    `${periodSubheading} · Opening ${formatMoney(openingBalance)} · Closing ${formatMoney(closingBalance)}`,
    [
      { label: 'Subgroup', width: 90 }, { label: 'Report status', width: 145 },
      { label: 'Fines', width: 85 }, { label: 'Socials', width: 85 },
      { label: 'Savings', width: 85 }, { label: 'Loan return', width: 95 },
      { label: 'Loan taken', width: 95 }
    ],
    reportRows.map((subgroup) => [
      `Subgroup ${subgroup.code}`, subgroup.status,
      formatMoney(subgroup.fines), formatMoney(subgroup.socials),
      formatMoney(subgroup.savings), formatMoney(subgroup.loan_return),
      formatMoney(subgroup.loan_taken)
    ]),
    [[
      'GROUP TOTAL', '',
      formatMoney(fromCents(groupTotals.fines)), formatMoney(fromCents(groupTotals.socials)),
      formatMoney(fromCents(groupTotals.savings)), formatMoney(fromCents(groupTotals.loan_return)),
      formatMoney(fromCents(groupTotals.loan_taken))
    ]]
  );
}));

app.get('/finance/contributions/:id/report.pdf', allowRoles('chairperson', 'financial_secretary', 'treasurer'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const [[targetMeeting]] = await db.pool.execute(
    'SELECT id, title, meeting_date FROM meetings WHERE id = ?',
    [meetingId]
  );
  if (!targetMeeting) return res.status(404).render('error', { title: 'Meeting not found', message: 'That meeting could not be found.' });
  const [configRows] = await db.pool.execute(
    'SELECT opening_balance, effective_from FROM subgroup_cashbook_config WHERE id = 1'
  );
  if (!configRows.length) throw new Error('The subgroup cashbook opening balance has not been configured.');
  const [meetings] = await db.pool.execute(
    `SELECT id, title, meeting_date FROM meetings
     WHERE DATE(meeting_date) >= ? AND (meeting_date < ? OR (meeting_date = ? AND id <= ?))
     ORDER BY meeting_date, id`,
    [configRows[0].effective_from, targetMeeting.meeting_date, targetMeeting.meeting_date, meetingId]
  );
  const meetingIds = meetings.map((meeting) => meeting.id);
  if (!meetingIds.some((id) => String(id) === String(meetingId))) {
    throw new Error('The selected meeting is outside the configured subgroup cashbook period.');
  }
  const placeholders = meetingIds.map(() => '?').join(', ');
  const [submissions] = await db.pool.execute(
    `SELECT meeting_id, subgroup_code, fines, socials, savings, loan_return,
       loan_taken, submitted_at, pending_changes
     FROM subgroup_cashbook_submissions
     WHERE submitted_at IS NOT NULL AND meeting_id IN (${placeholders})
     ORDER BY meeting_id, subgroup_code`,
    meetingIds
  );
  const report = createSubgroupCashbookSummaries(meetings, submissions, configRows[0].opening_balance)
    .find((meeting) => String(meeting.id) === String(meetingId));
  if (!report) throw new Error('The selected meeting is outside the configured subgroup cashbook period.');
  const formatMoney = (value) => `${res.locals.currency} ${Number(value).toFixed(2)}`;
  const statusText = (subgroup) => subgroup.pendingChanges
    ? 'Changes pending'
    : subgroup.submitted ? 'Submitted' : 'Awaiting report';
  sendPdfTable(
    res,
    `group-meeting-${meetingId}-transactions.pdf`,
    'Weekly group transactions',
    `${targetMeeting.title} · ${new Date(targetMeeting.meeting_date).toLocaleDateString('en', { dateStyle: 'long' })} · Submitted totals only · Opening ${formatMoney(report.summary.opening_balance)} · Closing ${formatMoney(report.summary.closing_balance)}`,
    [
      { label: 'Subgroup', width: 120 }, { label: 'Report status', width: 130 },
      { label: 'Fines', width: 85 }, { label: 'Socials', width: 85 },
      { label: 'Savings', width: 85 }, { label: 'Loan return', width: 95 },
      { label: 'Loan taken', width: 95 }
    ],
    report.subgroups.map((subgroup) => [
      `Subgroup ${subgroup.code}`,
      statusText(subgroup),
      formatMoney(subgroup.fines), formatMoney(subgroup.socials),
      formatMoney(subgroup.savings), formatMoney(subgroup.loan_return),
      formatMoney(subgroup.loan_taken)
    ]),
    [[
      'GROUP TOTAL', '',
      formatMoney(report.summary.fine), formatMoney(report.summary.social),
      formatMoney(report.summary.savings), formatMoney(report.summary.loan_return),
      formatMoney(report.summary.loans_disbursed)
    ]]
  );
}));

app.get('/finance/cashbook/:id', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const openingBalance = await transaction((connection) =>
    ensureMeetingCashbook(connection, meetingId, req.session.user.id)
  );
  const [[meeting]] = await db.pool.execute(
    'SELECT id, title, meeting_date FROM meetings WHERE id = ?',
    [meetingId]
  );
  const [members] = await db.pool.execute(
    `SELECT m.id, m.full_name, COALESCE(c.fine, 0) AS fine, COALESCE(c.social, 0) AS social,
       COALESCE(c.savings, 0) AS savings, COALESCE(r.loan_return, 0) AS loan_return
     FROM members m
     LEFT JOIN (
       SELECT c.member_id,
         SUM(IF(c.category = 'fine', c.amount, 0)) AS fine,
         SUM(IF(c.category = 'social', c.amount, 0)) AS social,
         SUM(IF(c.category = 'savings', c.amount, 0)) AS savings
       FROM contributions c JOIN transactions t ON t.id = c.transaction_id
       WHERE t.meeting_id = ? AND t.is_voided = FALSE GROUP BY c.member_id
     ) c ON c.member_id = m.id
     LEFT JOIN (
       SELECT l.member_id, SUM(r.amount) AS loan_return
       FROM loan_repayments r JOIN loans l ON l.id = r.loan_id
       JOIN transactions t ON t.id = r.transaction_id
       WHERE r.meeting_id = ? AND t.is_voided = FALSE GROUP BY l.member_id
     ) r ON r.member_id = m.id
     WHERE m.status = 'active' ORDER BY m.full_name`,
    [meetingId, meetingId]
  );
  const totals = await meetingCashTotals(db.pool, meetingId);
  res.render('finance/cashbook', {
    title: 'Meeting cashbook',
    meeting,
    members,
    summary: calculateCashSummary(openingBalance, totals)
  });
}));

app.post('/finance/cashbook/:id', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.params.id, 'Meeting');
  const categories = ['fine', 'social', 'savings', 'loan_return'];
  await transaction(async (connection) => {
    await ensureMeetingCashbook(connection, meetingId, req.session.user.id);
    const [members] = await connection.execute(
      "SELECT id, full_name, subgroup_code FROM members WHERE status = 'active' ORDER BY id FOR UPDATE"
    );
    for (const member of members) {
      const amounts = Object.fromEntries(categories.map((category) => [
        category,
        positiveMoney(req.body[`${category}_${member.id}`] || '0.00', category)
      ]));
      const amountsInCents = Object.fromEntries(
        categories.map((category) => [category, toCents(amounts[category])])
      );
      if (Object.values(amountsInCents).some((amount) => amount > 0) && subgroupCodes.includes(member.subgroup_code)) {
        const [records] = await connection.execute(
          `SELECT fine, social, savings, loan_return FROM subgroup_member_meeting_records
           WHERE meeting_id = ? AND member_id = ? FOR UPDATE`,
          [meetingId, member.id]
        );
        if (records.length) {
          await connection.execute(
            `INSERT INTO subgroup_member_meeting_revisions
             (meeting_id, member_id, subgroup_code, fine, social, savings, loan_return, changed_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              meetingId, member.id, member.subgroup_code, records[0].fine, records[0].social,
              records[0].savings, records[0].loan_return, req.session.user.id
            ]
          );
        }
      }
      for (const category of ['fine', 'social', 'savings']) {
        const amount = amounts[category];
        if (Number(amount) === 0) continue;
        const [ledger] = await connection.execute(
          'INSERT INTO transactions (transaction_type, amount, transaction_date, description, related_id, meeting_id, created_by) VALUES (?, ?, NOW(), ?, ?, ?, ?)',
          [category, amount, `${category[0].toUpperCase()}${category.slice(1)} — ${member.full_name}`, member.id, meetingId, req.session.user.id]
        );
        await connection.execute(
          'INSERT INTO contributions (member_id, amount, category, contribution_date, transaction_id) VALUES (?, ?, ?, NOW(), ?)',
          [member.id, amount, category, ledger.insertId]
        );
      }

      const loanReturn = amounts.loan_return;
      if (Number(loanReturn) > 0) {
        const [loans] = await connection.execute(
          `SELECT id, balance FROM loans
           WHERE member_id = ? AND status = 'active' AND balance > 0
           ORDER BY application_date, id FOR UPDATE`,
          [member.id]
        );
        let remainingCents = toCents(loanReturn);
        const outstandingCents = loans.reduce((total, loan) => total + toCents(loan.balance), 0);
        if (remainingCents > outstandingCents) {
          throw new Error(`Loan return for ${member.full_name} exceeds their active loan balance.`);
        }
        for (const loan of loans) {
          if (remainingCents === 0) break;
          const appliedCents = Math.min(remainingCents, toCents(loan.balance));
          await recordLoanRepayment(connection, loan, fromCents(appliedCents), meetingId, req.session.user.id);
          remainingCents -= appliedCents;
        }
      }

      if (subgroupCodes.includes(member.subgroup_code) && Object.values(amountsInCents).some((amount) => amount > 0)) {
        await connection.execute(
          `INSERT INTO subgroup_member_meeting_records
           (meeting_id, member_id, subgroup_code, fine, social, savings, loan_return, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE fine = fine + VALUES(fine), social = social + VALUES(social),
             savings = savings + VALUES(savings), loan_return = loan_return + VALUES(loan_return),
             updated_by = VALUES(updated_by)`,
          [
            meetingId, member.id, member.subgroup_code,
            amounts.fine, amounts.social, amounts.savings, amounts.loan_return, req.session.user.id
          ]
        );
        await connection.execute(
          `INSERT INTO subgroup_cashbook_submissions (meeting_id, subgroup_code, pending_changes)
           VALUES (?, ?, TRUE)
           ON DUPLICATE KEY UPDATE pending_changes = TRUE`,
          [meetingId, member.subgroup_code]
        );
      }
    }
    await recalculateCashbookCarryForwards(connection);
  });
  redirectNotice(res, `/finance/cashbook/${meetingId}`, 'Meeting collections recorded and cash carry-forward updated.');
}));

app.get('/finance/loans', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  await ensureWeeklyMeetings();
  const [loans] = await db.pool.execute(
    `SELECT l.*, m.full_name, COALESCE((SELECT SUM(lr.amount) FROM loan_repayments lr
       JOIN transactions t ON t.id = lr.transaction_id
       WHERE lr.loan_id = l.id AND t.is_voided = FALSE), 0) AS repaid
     FROM loans l JOIN members m ON m.id = l.member_id
     ORDER BY FIELD(l.status, 'pending', 'approved', 'active', 'rejected', 'repaid'), l.application_date DESC`
  );
  const [members] = await db.pool.execute("SELECT id, full_name FROM members WHERE status = 'active' ORDER BY full_name");
  const [meetings] = await db.pool.execute(
    'SELECT id, title, meeting_date FROM meetings WHERE meeting_date >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY) ORDER BY meeting_date DESC LIMIT 20'
  );
  res.render('finance/loans', {
    title: 'Loans', loans, members, meetings,
    defaultRate: await setting('interest_rate', '12.0000'),
    defaultTerm: await setting('default_loan_term_months', '12')
  });
}));

app.get('/finance/loans/:id/edit', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const [loans] = await db.pool.execute(
    `SELECT l.* FROM loans l
     WHERE l.id = ? AND l.status IN ('pending', 'approved') AND l.disbursed_at IS NULL`,
    [req.params.id]
  );
  if (!loans.length) {
    return res.status(409).render('error', {
      title: 'Loan cannot be edited',
      message: 'Only pending or approved loans that have not been disbursed can be changed.'
    });
  }
  const [members] = await db.pool.execute(
    `SELECT id, full_name, status FROM members
     WHERE status = 'active' OR id = ? ORDER BY full_name`,
    [loans[0].member_id]
  );
  res.render('finance/loan-form', {
    title: 'Update loan', loan: loans[0], members,
    defaultRate: await setting('interest_rate', '12.0000'),
    defaultTerm: await setting('default_loan_term_months', '12'),
    subgroup: false
  });
}));

app.post('/finance/loans/:id/edit', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const memberId = positiveId(req.body.member_id, 'Member');
  const amount = nonZeroMoney(req.body.amount, 'Loan amount');
  const purpose = requiredText(req.body.purpose, 'Loan purpose', 500);
  const termMonths = positiveInteger(req.body.term_months, 'Loan term');
  let wasApproved = false;
  await transaction(async (connection) => {
    const [loans] = await connection.execute(
      `SELECT id, member_id, status FROM loans
       WHERE id = ? AND status IN ('pending', 'approved') AND disbursed_at IS NULL FOR UPDATE`,
      [req.params.id]
    );
    const loan = loans[0];
    if (!loan) throw new Error('Only pending or approved loans that have not been disbursed can be changed.');
    const [members] = await connection.execute(
      `SELECT id FROM members
       WHERE id = ? AND (status = 'active' OR id = ?) FOR UPDATE`,
      [memberId, loan.member_id]
    );
    if (!members.length) throw new Error('Choose an active member.');
    wasApproved = loan.status === 'approved';
    await connection.execute(
      `UPDATE loans SET member_id = ?, amount = ?, term_months = ?, purpose = ?,
       status = 'pending', approval_date = NULL, approved_by = NULL
       WHERE id = ?`,
      [memberId, amount, termMonths, purpose, req.params.id]
    );
  });
  redirectNotice(
    res,
    '/finance/loans',
    wasApproved ? 'Loan updated; it must be approved again before disbursement.' : 'Loan application updated.'
  );
}));

app.post('/finance/loans', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const memberId = positiveId(req.body.member_id, 'Member');
  const amount = nonZeroMoney(req.body.amount);
  const purpose = requiredText(req.body.purpose, 'Loan purpose', 500);
  const interestRate = Number(await setting('interest_rate', '12.0000'));
  const termMonths = positiveInteger(req.body.term_months || await setting('default_loan_term_months', '12'), 'Loan term');
  await transaction(async (connection) => {
    const [members] = await connection.execute(
      "SELECT id FROM members WHERE id = ? AND status = 'active' FOR UPDATE",
      [memberId]
    );
    if (!members.length) throw new Error('Choose an active member.');
    await connection.execute(
      'INSERT INTO loans (member_id, amount, interest_rate, term_months, application_date, purpose) VALUES (?, ?, ?, ?, CURRENT_DATE, ?)',
      [memberId, amount, interestRate, termMonths, purpose]
    );
  });
  redirectNotice(res, '/finance/loans', 'Loan application recorded for review.');
}));

app.post('/finance/loans/:id/review', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  if (!['approved', 'rejected'].includes(req.body.decision)) throw new Error('Choose approve or reject.');
  const [result] = await db.pool.execute(
    `UPDATE loans SET status = ?, approval_date = CURRENT_DATE, approved_by = ?
     WHERE id = ? AND status = 'pending'`,
    [req.body.decision, req.session.user.id, req.params.id]
  );
  if (!result.affectedRows) throw new Error('Only pending loan applications can be reviewed.');
  redirectNotice(res, '/finance/loans', `Loan application ${req.body.decision}.`);
}));

app.post('/finance/loans/:id/disburse', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const meetingId = positiveId(req.body.meeting_id, 'Meeting');
  await transaction((connection) =>
    disburseLoan(connection, req.params.id, meetingId, req.session.user.id)
  );
  redirectNotice(res, '/finance/loans', 'Loan disbursed and repayment schedule created.');
}));

app.post('/finance/loans/:id/repayments', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const amount = nonZeroMoney(req.body.amount, 'Repayment');
  await transaction(async (connection) => {
    const [loans] = await connection.execute('SELECT * FROM loans WHERE id = ? FOR UPDATE', [req.params.id]);
    const loan = loans[0];
    if (!loan || loan.status !== 'active') throw new Error('Repayments can only be recorded for active loans.');
    if (Number(amount) > Number(loan.balance)) throw new Error('Repayment cannot exceed the outstanding balance.');
    const [ledger] = await connection.execute(
      'INSERT INTO transactions (transaction_type, amount, transaction_date, description, related_id, created_by) VALUES (?, ?, NOW(), ?, ?, ?)',
      ['loan_repayment', amount, `Loan repayment — ${loan.id}`, loan.id, req.session.user.id]
    );
    await connection.execute(
      'INSERT INTO loan_repayments (loan_id, amount, repayment_date, transaction_id) VALUES (?, ?, NOW(), ?)',
      [loan.id, amount, ledger.insertId]
    );
    let remainingCents = Math.round(Number(amount) * 100);
    const [schedule] = await connection.execute(
      'SELECT id, amount_due, amount_paid FROM repayment_schedule WHERE loan_id = ? ORDER BY installment_number FOR UPDATE',
      [loan.id]
    );
    for (const installment of schedule) {
      if (remainingCents <= 0) break;
      const dueCents = Math.round(Number(installment.amount_due) * 100);
      const paidCents = Math.round(Number(installment.amount_paid) * 100);
      const appliedCents = Math.min(dueCents - paidCents, remainingCents);
      if (appliedCents > 0) {
        const newPaidCents = paidCents + appliedCents;
        await connection.execute(
          'UPDATE repayment_schedule SET amount_paid = ?, paid_at = IF(? >= amount_due, NOW(), NULL) WHERE id = ?',
          [(newPaidCents / 100).toFixed(2), (newPaidCents / 100).toFixed(2), installment.id]
        );
        remainingCents -= appliedCents;
      }
    }
    const balanceCents = Math.max(0, Math.round(Number(loan.balance) * 100) - Math.round(Number(amount) * 100));
    await connection.execute(
      "UPDATE loans SET balance = ?, status = IF(? = 0, 'repaid', 'active') WHERE id = ?",
      [(balanceCents / 100).toFixed(2), balanceCents, loan.id]
    );
  });
  redirectNotice(res, '/finance/loans', 'Repayment recorded.');
}));

app.get('/finance/loans/:id/schedule', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const [loans] = await db.pool.execute(
    'SELECT l.id, l.status, l.balance, m.full_name FROM loans l JOIN members m ON m.id = l.member_id WHERE l.id = ?',
    [req.params.id]
  );
  if (!loans.length) return res.status(404).render('error', { title: 'Loan not found', message: 'That loan could not be found.' });
  const [schedule] = await db.pool.execute(
    'SELECT installment_number, due_date, amount_due, amount_paid FROM repayment_schedule WHERE loan_id = ? ORDER BY installment_number',
    [req.params.id]
  );
  res.render('finance/schedule', { title: `Loan #${req.params.id} schedule`, loan: loans[0], schedule, subgroup: false });
}));

app.post('/finance/expenses', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const amount = nonZeroMoney(req.body.amount, 'Expense');
  const description = requiredText(req.body.description, 'Expense description', 500);
  await db.pool.execute(
    'INSERT INTO transactions (transaction_type, amount, transaction_date, description, created_by) VALUES (?, ?, NOW(), ?, ?)',
    ['expense', amount, description, req.session.user.id]
  );
  redirectNotice(res, '/finance/reports', 'Expense recorded.');
}));

app.get('/finance/reports', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const [totals] = await db.pool.execute(
    `SELECT transaction_type, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
     FROM transactions WHERE is_voided = FALSE GROUP BY transaction_type ORDER BY transaction_type`
  );
  const [transactions] = await db.pool.execute(
    `SELECT t.id, t.transaction_type, t.amount, t.transaction_date, t.description, u.full_name AS recorded_by
     FROM transactions t LEFT JOIN users u ON u.id = t.created_by
     WHERE t.is_voided = FALSE
     ORDER BY t.transaction_date DESC, t.id DESC LIMIT 200`
  );
  const [loanTotals] = await db.pool.execute(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(balance), 0) AS balance
     FROM loans GROUP BY status ORDER BY status`
  );
  res.render('finance/reports', { title: 'Financial reports', totals, transactions, loanTotals });
}));

app.get('/finance/reports.csv', allowRoles('chairperson', 'treasurer'), asyncRoute(async (req, res) => {
  const [rows] = await db.pool.execute(
    'SELECT id, transaction_type, amount, transaction_date, description FROM transactions WHERE is_voided = FALSE ORDER BY transaction_date DESC, id DESC'
  );
  const csv = [
    ['ID', 'Type', 'Amount', 'Date', 'Description'].map(csvCell).join(','),
    ...rows.map((row) => [row.id, row.transaction_type, row.amount, row.transaction_date, row.description].map(csvCell).join(','))
  ].join('\r\n');
  res.type('text/csv; charset=utf-8');
  res.attachment('hsms-financial-report.csv');
  res.send(csv);
}));

app.get('/users', allowRoles('chairperson'), asyncRoute(async (req, res) => {
  const [users] = await db.pool.execute(
    'SELECT id, username, full_name, role, subgroup_code, is_active, created_at FROM users ORDER BY role, subgroup_code, full_name'
  );
  const [subgroups] = await db.pool.execute('SELECT code, name FROM subgroups ORDER BY code');
  res.render('users/index', { title: 'User accounts', users, subgroups });
}));

app.post('/users', allowRoles('chairperson'), asyncRoute(async (req, res) => {
  const username = requiredText(req.body.username, 'Username', 80);
  const fullName = requiredText(req.body.full_name, 'Full name', 160);
  const role = ['secretary', 'financial_secretary', 'treasurer', 'subgroup_chairperson', 'subgroup_secretary'].includes(req.body.role)
    ? req.body.role : null;
  const subgroupCode = ['subgroup_chairperson', 'subgroup_secretary'].includes(role) && subgroupCodes.includes(req.body.subgroup_code)
    ? req.body.subgroup_code : null;
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(username)) throw new Error('Username must use 3–80 letters, numbers, dots, dashes, or underscores.');
  if (!role) throw new Error('Choose a valid officer role.');
  if (['subgroup_chairperson', 'subgroup_secretary'].includes(role) && !subgroupCode) {
    throw new Error('Assign this subgroup officer to subgroup A, B, C or D.');
  }
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Password must be at least 12 characters and no more than 72 bytes.');
  }
  const hash = await bcrypt.hash(password, 12);
  await transaction(async (connection) => {
    if (subgroupCode) {
      await connection.execute('SELECT code FROM subgroups WHERE code = ? FOR UPDATE', [subgroupCode]);
      const [existingChairs] = await connection.execute(
        `SELECT id FROM users
         WHERE role = 'subgroup_chairperson' AND subgroup_code = ? AND is_active = TRUE LIMIT 1`,
        [subgroupCode]
      );
      if (existingChairs.length) throw new Error(`Subgroup ${subgroupCode} already has an active chairperson account.`);
    }
    await connection.execute(
      'INSERT INTO users (username, password_hash, full_name, role, subgroup_code) VALUES (?, ?, ?, ?, ?)',
      [username, hash, fullName, role, subgroupCode]
    );
  });
  redirectNotice(res, '/users', 'User account created.');
}));

app.post('/users/:id/status', allowRoles('chairperson'), asyncRoute(async (req, res) => {
  if (String(req.session.user.id) === String(req.params.id)) throw new Error('You cannot deactivate your own account.');
  if (!['0', '1'].includes(req.body.is_active)) throw new Error('Invalid account status.');
  await transaction(async (connection) => {
    const [accounts] = await connection.execute(
      'SELECT id, role, subgroup_code, is_active FROM users WHERE id = ? FOR UPDATE',
      [req.params.id]
    );
    const account = accounts[0];
    if (!account) throw new Error('The account could not be updated.');
    if (account.role === 'chairperson' && account.is_active && req.body.is_active === '0') {
      const [[activeChairpersons]] = await connection.execute(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'chairperson' AND is_active = TRUE"
      );
      if (Number(activeChairpersons.count) <= 1) {
        throw new Error('The last active Chairperson account cannot be deactivated.');
      }
    }
    if (req.body.is_active === '1' && account.role === 'subgroup_chairperson') {
      if (!subgroupCodes.includes(account.subgroup_code)) {
        throw new Error('Assign this subgroup chairperson to a subgroup before reactivating the account.');
      }
      await connection.execute('SELECT code FROM subgroups WHERE code = ? FOR UPDATE', [account.subgroup_code]);
      const [otherChairs] = await connection.execute(
        `SELECT id FROM users
         WHERE role = 'subgroup_chairperson' AND subgroup_code = ? AND is_active = TRUE AND id <> ?
         LIMIT 1`,
        [account.subgroup_code, account.id]
      );
      if (otherChairs.length) throw new Error(`Subgroup ${account.subgroup_code} already has an active chairperson account.`);
    }
    await connection.execute('UPDATE users SET is_active = ? WHERE id = ?', [Number(req.body.is_active), account.id]);
  });
  redirectNotice(res, '/users', 'Account status updated.');
}));

app.post('/users/:id/password', allowRoles('chairperson'), asyncRoute(async (req, res) => {
  if (String(req.session.user.id) === String(req.params.id)) {
    throw new Error('Use your own account password controls to change your password.');
  }
  const password = typeof req.body.new_password === 'string' ? req.body.new_password : '';
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Password must be at least 12 characters and no more than 72 bytes.');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await transaction(async (connection) => {
    const [accounts] = await connection.execute(
      'SELECT id FROM users WHERE id = ? AND id <> ? FOR UPDATE',
      [req.params.id, req.session.user.id]
    );
    if (!accounts.length) throw new Error('The other officer account could not be found.');
    await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, accounts[0].id]);
    await connection.execute(
      `DELETE FROM sessions
       WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.user.id')) = CAST(? AS CHAR)`,
      [accounts[0].id]
    );
  });
  redirectNotice(res, '/users', 'Officer password reset; their existing sessions have been signed out.');
}));

app.post('/users/:id/delete', allowRoles('chairperson'), asyncRoute(async (req, res) => {
  if (String(req.session.user.id) === String(req.params.id)) {
    throw new Error('You cannot delete the account you are currently using.');
  }
  await transaction(async (connection) => {
    const [accounts] = await connection.execute(
      'SELECT id, role, is_active FROM users WHERE id = ? FOR UPDATE',
      [req.params.id]
    );
    const account = accounts[0];
    if (!account) throw Object.assign(new Error('The officer account could not be found.'), { status: 404 });
    if (account.role === 'chairperson' && account.is_active) {
      const [[activeChairpersons]] = await connection.execute(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'chairperson' AND is_active = TRUE"
      );
      if (Number(activeChairpersons.count) <= 1) {
        throw new Error('The last active Chairperson account cannot be deleted.');
      }
    }
    await connection.execute(
      `DELETE FROM sessions
       WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.user.id')) = CAST(? AS CHAR)`,
      [account.id]
    );
    await connection.execute('DELETE FROM users WHERE id = ?', [account.id]);
  });
  redirectNotice(res, '/users', 'Officer account deleted and active sessions revoked.');
}));

app.get('/settings', allowRoles('chairperson'), asyncRoute(async (req, res) => {
  const [rows] = await db.pool.execute('SELECT setting_key, setting_value FROM group_settings');
  const settings = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  res.locals.groupName = settings.group_name || res.locals.groupName;
  res.render('settings', { title: 'Group settings', settings });
}));

app.post('/settings', allowRoles('chairperson'), asyncRoute(async (req, res) => {
  const groupName = requiredText(req.body.group_name, 'Group name', 160);
  const fee = positiveMoney(req.body.registration_fee || '0.00', 'Registration fee');
  const rate = Number(req.body.interest_rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Interest rate must be between 0 and 100 percent.');
  const term = positiveInteger(req.body.default_loan_term_months, 'Default loan term');
  const currency = requiredText(req.body.currency, 'Currency', 8);
  if (!/^[A-Z]{3,8}$/.test(currency)) throw new Error('Currency must be an uppercase code, for example KES or USD.');
  await transaction(async (connection) => {
    for (const [key, value] of Object.entries({
      group_name: groupName, registration_fee: fee,
      interest_rate: rate.toFixed(4), default_loan_term_months: String(term), currency
    })) {
      await connection.execute(
        `INSERT INTO group_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, value]
      );
    }
  });
  redirectNotice(res, '/settings', 'Group settings saved.');
}));

app.use((req, res) => res.status(404).render('error', {
  title: 'Page not found',
  message: 'The page you requested does not exist.'
}));

app.use((error, req, res, _next) => {
  console.error('Request failed:', error);
  const isConflict = ['ER_DUP_ENTRY', 'ER_ROW_IS_REFERENCED_2', 'ER_NO_REFERENCED_ROW_2'].includes(error.code);
  const status = error.status || (isConflict ? 409 : error.code ? 500 : 400);
  const message = error.code === 'ER_DUP_ENTRY'
    ? 'That value is already in use. Check for an existing username or record.'
    : ['ER_ROW_IS_REFERENCED_2', 'ER_NO_REFERENCED_ROW_2'].includes(error.code)
      ? 'This record is linked to other group records and cannot be removed.'
      : (status >= 500 ? 'The request could not be completed. Please try again or contact your system administrator.' : error.message);
  if (res.headersSent) return;
  res.status(status).render('error', { title: status >= 500 ? 'Something went wrong' : 'Please check your entry', message });
});

let server;

async function start() {
  await ensureWeeklyMeetings();
  server = app.listen(port, () => console.log(`HSMS listening on port ${port}`));
}

start().catch(async (error) => {
  console.error('Application startup failed:', error);
  clearInterval(sessionCleanup);
  await db.pool.end();
  process.exitCode = 1;
});

async function shutdown() {
  clearInterval(sessionCleanup);
  server.close(async () => {
    await db.pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
