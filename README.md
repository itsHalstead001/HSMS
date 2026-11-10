# Halstead SHG Management System

A server-rendered, role-based application for managing a Self-Help Group’s membership, meetings, documents and financial records. The application uses Node.js, Express, EJS and MySQL.

## Requirements

- Node.js 20 or newer
- MySQL 8.0.16 or newer
- npm

## Local setup

1. Create a MySQL application user with permission to create tables and indexes in the application database. For example, from a privileged MySQL account:

   ```sql
   CREATE USER 'hsms_app'@'localhost' IDENTIFIED BY 'use-a-unique-strong-password';
   GRANT ALL PRIVILEGES ON hsms.* TO 'hsms_app'@'localhost';
   ```

2. Copy `.env.example` to `.env` and replace the database credential placeholders with your own values. Generate a session secret with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`. Session cookies are automatically marked secure in production; for local HTTPS in development, set `SESSION_COOKIE_SECURE=true`. If TLS terminates at a trusted reverse proxy, set `TRUST_PROXY=1`.
3. Install dependencies and initialize the schema:

   ```sh
   npm install
   mysql -u root -p < database.sql
   npm run migrate-meeting-finance
   ```

   The migration adds meeting-linked payment categories, four subgroups, member-level subgroup records and aggregate cashbooks to existing databases. Grant the application database user permission to alter the `hsms` schema when running the migration. Existing members remain unassigned until the Membership Secretary or Chairperson edits their profiles.
4. Create or update the chairperson account. Set `CHAIRPERSON_USERNAME`, `CHAIRPERSON_FULL_NAME`, and `CHAIRPERSON_PASSWORD` in the private `.env` (the `.env.example` file documents these fields), then run:

   ```sh
   npm run create-admin
   ```

   The password must be at least 12 characters and no more than 72 UTF-8 bytes. The command stores only a bcrypt hash. It creates the initial chairperson if none exists; if exactly one exists, it updates that account and signs out its existing sessions. If all three chairperson variables are left unset, the command prompts for the account details instead. Replace all template values before running it; never use a shared or publicly committed default password.
5. Start the server:

   ```sh
   npm start
   ```

   Open `http://localhost:3001`.

For development, `npm run dev` starts the server with nodemon.

## Roles

- **Chairperson:** group oversight, member and officer administration, settings, meetings, documents, financial reports and loan approvals.
- **Secretary:** member registration and contact maintenance, meetings, attendance and documents. Financial information is not shown in member profiles or dashboards.
- **Financial Secretary:** receives group-level totals for fines, socials, savings, loan returns and loans taken. Member-level financial records, loans and the transaction ledger are not available to this role.
- **Treasurer:** loan applications and review, member-level cashbooks, disbursements, repayments, expenses and reports.
- **Subgroup Chairperson:** views and updates member profiles and meeting financial records for their assigned subgroup only, processes subgroup loan applications, corrects or clears erroneous entries with an audit history, and explicitly submits calculated subgroup totals to the Financial Secretary.
- **Subgroup Secretary:** views the member directory for their assigned subgroup, records subgroup attendance and meeting notes, and cannot access member finances.

The Chairperson creates subgroup officer accounts and assigns each to subgroup A–D. Each subgroup can have at most one active Subgroup Chairperson. The Membership Secretary assigns every new member to a subgroup and can update existing assignments. Every page and write action is protected on the server by role middleware and subgroup-scoped database conditions. All state-changing forms include a session-bound CSRF token. Sessions are stored in MySQL through the application's shared connection pool rather than process memory.

## Thursday meetings and cashbooks

The system automatically creates the next eight weekly Thursday meetings (10:00 by default) without duplicating an existing meeting on the same date. The meeting form defaults to the next Thursday; officers can change the date and time for a special meeting.

At each meeting, Subgroup Chairpersons enter each member's fine, social, savings and loan return. Entries remain in the subgroup's meeting records after submission; later edits or clears are retained in the revision/ledger audit history and flagged until the corrected totals are resubmitted. Loan amounts taken are calculated from actual subgroup loan disbursements. The Financial Secretary sees only submitted group-level totals. Both roles can download weekly PDF reports: subgroup chairpersons receive member-level details for their own subgroup, while the Financial Secretary receives only subgroup/group aggregates. Subgroup Secretaries record attendance and subgroup meeting notes for their assigned members. Opening carry-forward plus fines, socials, savings and loan returns, less loans taken, gives the closing carry-forward for the next meeting. The migration seeds the group cashbook with the non-voided ledger's net cash total and records the date the subgroup summary begins. The Chairperson and Treasurer also have a group-wide member-level cashbook and can view the individual transaction ledger.

After a Subgroup Chairperson saves or clears a member's meeting record, HSMS sends that member an SMS with the meeting date, subgroup, fine, social, savings, loan return, loan taken and total paid. The total paid excludes loan disbursements. Configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` in the private `.env` to enable delivery. `TWILIO_DEFAULT_COUNTRY_CODE` defaults to `254`, so Kenyan numbers entered as `0712345678` or `712345678` are converted to `+254712345678`; international member numbers can be entered with a leading `+`. The Twilio sender number must be in E.164 format. Trial accounts can message only verified recipients: add each member recipient in Twilio Console under **Phone Numbers → Manage → Verified Caller IDs**, or upgrade the Twilio account. HSMS identifies this trial restriction in the chairperson's warning. If another SMS delivery error occurs, the record change remains saved; correct the contact/configuration and save again to retry.

The Financial Secretary and Subgroup Chairperson can choose a weekly, monthly, quarterly or yearly PDF report and select a date within that period. Group reports contain submitted subgroup totals only; subgroup reports contain the member-level records for the assigned subgroup.

Password fields include a show/hide control. Officer account creation also displays a live strength estimate; server-side password requirements remain enforced.

## Financial records and loan calculations

Every recorded fee, contribution, disbursement, repayment and expense has a distinct row in the central `transactions` ledger. The ledger amount is always positive; the transaction type determines whether it is income or expenditure.

Loan interest uses annual simple interest: `principal × annual rate × term months ÷ 12`. Disbursement creates an equal monthly repayment schedule, with any rounding remainder assigned to the final installment. Repayment entries are applied to the earliest unpaid installments and cannot exceed the outstanding balance. Loan and ledger writes are committed together in database transactions.

The ledger is the authoritative financial audit trail. Corrections void the superseded transaction and preserve prior values in revision history; do not hard-delete ledger entries directly.

Chairpersons can deactivate or delete other officer accounts and can reset an officer's password. Passwords are stored as bcrypt hashes and cannot be viewed or recovered; a reset creates a new password and signs out the target account's existing sessions.

To clear financial test data while preserving accounts, members, meetings, attendance and subgroup meeting notes, run `npm run reset-financial-test-data` with `CONFIRM_FINANCIAL_DATA_RESET=YES` set in the environment. This permanently deletes loans, repayments, schedules, contributions, transactions, cashbooks, subgroup submissions and financial revision records, and resets registration-fee totals and the opening balance.

## Deployment

Deploy to a Node.js host with Node 20+, a reachable MySQL 8 database, and persistent storage for uploaded group documents. Configure the environment variables from `.env.example`; never commit `.env` or real credentials in `.env.example`. Run the schema script once before first startup, create the initial chairperson, then start with `npm start`. Configure the host’s health monitoring and HTTPS termination, set `SESSION_COOKIE_SECURE=true`, and use `TRUST_PROXY=1` only behind a trusted single proxy hop. The process handles `SIGTERM` and `SIGINT` for graceful shutdown.

Document uploads are stored outside the public web root. The host must preserve the configured `UPLOAD_DIR` across restarts and deployments, or provide a persistent mounted volume. Back up the database and document directory together.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port; defaults to `3001`. |
| `TRUST_PROXY` | Set to `1` when behind a trusted reverse proxy. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | MySQL connection settings. |
| `DB_CONNECTION_LIMIT` | MySQL pool size; defaults to `10`. |
| `SESSION_SECRET` | Session signing key; at least 32 characters in production. |
| `SESSION_COOKIE_SECURE` | Set to `true` when the app is served over HTTPS. |
| `UPLOAD_DIR` | Private document storage; defaults to `storage/documents`. |
| `MAX_UPLOAD_MB` | Maximum document size; defaults to `10`. |

## Project layout

```text
app.js                 Express routes, authorization and business logic
database.sql           MySQL schema, indexes and default group settings
scripts/create-admin.js Interactive first-chairperson setup
scripts/migrate-meeting-finance.js Existing database migration for meeting and subgroup cashbooks
src/db.js              mysql2 connection pool
src/mysql-session-store.js MySQL-backed express-session store
src/meeting-cashbook.js Thursday schedule and cash arithmetic helpers
src/subgroup-cashbook.js Group aggregation and cash carry-forward calculations
views/                 EJS server-rendered pages and shared layout
public/                Custom responsive CSS and small vanilla JS helpers
```
