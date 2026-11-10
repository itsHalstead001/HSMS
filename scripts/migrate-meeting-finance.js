require('dotenv').config({ path: require('node:fs').existsSync('.env') ? '.env' : '.env.example' });
const mysql = require('mysql2/promise');

async function columnExists(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return rows.length > 0;
}

async function indexExists(connection, table, index) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  return rows.length > 0;
}

async function foreignKeyExists(connection, constraint) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.referential_constraints
     WHERE constraint_schema = DATABASE() AND constraint_name = ?`,
    [constraint]
  );
  return rows.length > 0;
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });
  try {
    await connection.execute(
      `CREATE TABLE IF NOT EXISTS subgroups (
        code CHAR(1) NOT NULL,
        name VARCHAR(80) NOT NULL,
        PRIMARY KEY (code),
        CONSTRAINT chk_subgroups_code CHECK (code IN ('A', 'B', 'C', 'D'))
      ) ENGINE=InnoDB`
    );
    await connection.execute(
      `INSERT INTO subgroups (code, name) VALUES
       ('A', 'Subgroup A'), ('B', 'Subgroup B'), ('C', 'Subgroup C'), ('D', 'Subgroup D')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`
    );
    await connection.execute(
      `ALTER TABLE users MODIFY role
       ENUM('chairperson', 'secretary', 'financial_secretary', 'treasurer',
         'subgroup_chairperson', 'subgroup_secretary') NOT NULL`
    );
    if (!(await columnExists(connection, 'users', 'subgroup_code'))) {
      await connection.execute('ALTER TABLE users ADD COLUMN subgroup_code CHAR(1) NULL');
    }
    if (!(await indexExists(connection, 'users', 'idx_users_subgroup'))) {
      await connection.execute('ALTER TABLE users ADD KEY idx_users_subgroup (subgroup_code)');
    }
    if (!(await foreignKeyExists(connection, 'fk_users_subgroup'))) {
      await connection.execute(
        `ALTER TABLE users ADD CONSTRAINT fk_users_subgroup
         FOREIGN KEY (subgroup_code) REFERENCES subgroups (code) ON DELETE SET NULL`
      );
    }
    if (!(await columnExists(connection, 'members', 'subgroup_code'))) {
      await connection.execute('ALTER TABLE members ADD COLUMN subgroup_code CHAR(1) NULL');
    }
    if (!(await indexExists(connection, 'members', 'idx_members_subgroup_status'))) {
      await connection.execute('ALTER TABLE members ADD KEY idx_members_subgroup_status (subgroup_code, status)');
    }
    if (!(await foreignKeyExists(connection, 'fk_members_subgroup'))) {
      await connection.execute(
        `ALTER TABLE members ADD CONSTRAINT fk_members_subgroup
         FOREIGN KEY (subgroup_code) REFERENCES subgroups (code) ON DELETE SET NULL`
      );
    }
    await connection.execute(
      `ALTER TABLE transactions MODIFY transaction_type
       ENUM('registration_fee', 'contribution', 'fine', 'social', 'savings',
         'loan_disbursement', 'loan_repayment', 'loan_return', 'expense') NOT NULL`
    );

    if (!(await columnExists(connection, 'transactions', 'meeting_id'))) {
      await connection.execute('ALTER TABLE transactions ADD COLUMN meeting_id BIGINT UNSIGNED NULL');
    }
    if (!(await columnExists(connection, 'transactions', 'is_voided'))) {
      await connection.execute('ALTER TABLE transactions ADD COLUMN is_voided BOOLEAN NOT NULL DEFAULT FALSE');
    }
    if (!(await indexExists(connection, 'transactions', 'idx_transactions_meeting_type'))) {
      await connection.execute('ALTER TABLE transactions ADD KEY idx_transactions_meeting_type (meeting_id, transaction_type)');
    }

    if (!(await columnExists(connection, 'contributions', 'category'))) {
      await connection.execute(
        `ALTER TABLE contributions ADD COLUMN category
         ENUM('registration_fee', 'fine', 'social', 'savings') NOT NULL DEFAULT 'savings'`
      );
    }
    if (!(await indexExists(connection, 'contributions', 'idx_contributions_category_date'))) {
      await connection.execute('ALTER TABLE contributions ADD KEY idx_contributions_category_date (category, contribution_date)');
    }
    await connection.execute(
      `UPDATE contributions c
       JOIN transactions t ON t.id = c.transaction_id
       SET c.category = 'registration_fee'
       WHERE t.transaction_type = 'registration_fee'`
    );

    if (!(await columnExists(connection, 'loan_repayments', 'meeting_id'))) {
      await connection.execute('ALTER TABLE loan_repayments ADD COLUMN meeting_id BIGINT UNSIGNED NULL');
    }
    if (!(await indexExists(connection, 'loan_repayments', 'idx_repayments_meeting'))) {
      await connection.execute('ALTER TABLE loan_repayments ADD KEY idx_repayments_meeting (meeting_id)');
    }

    if (!(await columnExists(connection, 'meetings', 'weekly_occurrence'))) {
      await connection.execute('ALTER TABLE meetings ADD COLUMN weekly_occurrence DATE NULL');
    }
    if (!(await indexExists(connection, 'meetings', 'uq_meetings_weekly_occurrence'))) {
      await connection.execute('ALTER TABLE meetings ADD UNIQUE KEY uq_meetings_weekly_occurrence (weekly_occurrence)');
    }

    await connection.execute(
      `CREATE TABLE IF NOT EXISTS meeting_cashbooks (
        meeting_id BIGINT UNSIGNED NOT NULL,
        opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        created_by BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (meeting_id),
        CONSTRAINT fk_cashbooks_meeting FOREIGN KEY (meeting_id)
          REFERENCES meetings (id) ON DELETE CASCADE,
        CONSTRAINT fk_cashbooks_user FOREIGN KEY (created_by)
          REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT chk_cashbooks_opening_balance CHECK (opening_balance >= 0)
      ) ENGINE=InnoDB`
    );
    await connection.execute(
      `CREATE TABLE IF NOT EXISTS subgroup_cashbook_submissions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        meeting_id BIGINT UNSIGNED NOT NULL,
        subgroup_code CHAR(1) NOT NULL,
        fines DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        socials DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        savings DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        loan_return DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        loan_taken DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        submitted_by BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_subgroup_cashbook_meeting (meeting_id, subgroup_code),
        KEY idx_subgroup_cashbook_subgroup_meeting (subgroup_code, meeting_id),
        CONSTRAINT fk_subgroup_cashbook_meeting FOREIGN KEY (meeting_id)
          REFERENCES meetings (id) ON DELETE CASCADE,
        CONSTRAINT fk_subgroup_cashbook_subgroup FOREIGN KEY (subgroup_code)
          REFERENCES subgroups (code) ON DELETE RESTRICT,
        CONSTRAINT fk_subgroup_cashbook_user FOREIGN KEY (submitted_by)
          REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT chk_subgroup_cashbook_amounts CHECK (
          fines >= 0 AND socials >= 0 AND savings >= 0 AND loan_return >= 0 AND loan_taken >= 0
        )
      ) ENGINE=InnoDB`
    );
    if (!(await columnExists(connection, 'subgroup_cashbook_submissions', 'submitted_at'))) {
      await connection.execute(
        'ALTER TABLE subgroup_cashbook_submissions ADD COLUMN submitted_at DATETIME NULL'
      );
      await connection.execute(
        'UPDATE subgroup_cashbook_submissions SET submitted_at = updated_at'
      );
    }
    if (!(await columnExists(connection, 'subgroup_cashbook_submissions', 'pending_changes'))) {
      await connection.execute(
        'ALTER TABLE subgroup_cashbook_submissions ADD COLUMN pending_changes BOOLEAN NOT NULL DEFAULT FALSE'
      );
    }
    await connection.execute(
      `CREATE TABLE IF NOT EXISTS subgroup_member_meeting_records (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        meeting_id BIGINT UNSIGNED NOT NULL,
        member_id BIGINT UNSIGNED NOT NULL,
        subgroup_code CHAR(1) NOT NULL,
        fine DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        social DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        savings DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        loan_return DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        updated_by BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_subgroup_member_meeting (meeting_id, member_id),
        KEY idx_subgroup_member_records (subgroup_code, meeting_id),
        CONSTRAINT fk_subgroup_member_record_meeting FOREIGN KEY (meeting_id)
          REFERENCES meetings (id) ON DELETE CASCADE,
        CONSTRAINT fk_subgroup_member_record_member FOREIGN KEY (member_id)
          REFERENCES members (id) ON DELETE RESTRICT,
        CONSTRAINT fk_subgroup_member_record_subgroup FOREIGN KEY (subgroup_code)
          REFERENCES subgroups (code) ON DELETE RESTRICT,
        CONSTRAINT fk_subgroup_member_record_user FOREIGN KEY (updated_by)
          REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT chk_subgroup_member_record_amounts CHECK (
          fine >= 0 AND social >= 0 AND savings >= 0 AND loan_return >= 0
        )
      ) ENGINE=InnoDB`
    );
    await connection.execute(
      `CREATE TABLE IF NOT EXISTS subgroup_member_meeting_revisions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        meeting_id BIGINT UNSIGNED NOT NULL,
        member_id BIGINT UNSIGNED NOT NULL,
        subgroup_code CHAR(1) NOT NULL,
        fine DECIMAL(12,2) NOT NULL,
        social DECIMAL(12,2) NOT NULL,
        savings DECIMAL(12,2) NOT NULL,
        loan_return DECIMAL(12,2) NOT NULL,
        changed_by BIGINT UNSIGNED NULL,
        revised_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_subgroup_member_record_revision (meeting_id, member_id, revised_at),
        CONSTRAINT fk_subgroup_member_revision_meeting FOREIGN KEY (meeting_id)
          REFERENCES meetings (id) ON DELETE CASCADE,
        CONSTRAINT fk_subgroup_member_revision_member FOREIGN KEY (member_id)
          REFERENCES members (id) ON DELETE RESTRICT,
        CONSTRAINT fk_subgroup_member_revision_subgroup FOREIGN KEY (subgroup_code)
          REFERENCES subgroups (code) ON DELETE RESTRICT,
        CONSTRAINT fk_subgroup_member_revision_user FOREIGN KEY (changed_by)
          REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB`
    );
    await connection.execute(
      `CREATE TABLE IF NOT EXISTS subgroup_meeting_notes (
        meeting_id BIGINT UNSIGNED NOT NULL,
        subgroup_code CHAR(1) NOT NULL,
        notes TEXT NULL,
        updated_by BIGINT UNSIGNED NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (meeting_id, subgroup_code),
        CONSTRAINT fk_subgroup_meeting_notes_meeting FOREIGN KEY (meeting_id)
          REFERENCES meetings (id) ON DELETE CASCADE,
        CONSTRAINT fk_subgroup_meeting_notes_subgroup FOREIGN KEY (subgroup_code)
          REFERENCES subgroups (code) ON DELETE RESTRICT,
        CONSTRAINT fk_subgroup_meeting_notes_user FOREIGN KEY (updated_by)
          REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB`
    );
    await connection.execute(
      `INSERT INTO subgroup_member_meeting_records
       (meeting_id, member_id, subgroup_code, fine, social, savings)
       SELECT t.meeting_id, c.member_id, m.subgroup_code,
         SUM(IF(c.category = 'fine', c.amount, 0)),
         SUM(IF(c.category = 'social', c.amount, 0)),
         SUM(IF(c.category = 'savings', c.amount, 0))
       FROM contributions c
       JOIN transactions t ON t.id = c.transaction_id AND t.is_voided = FALSE
       JOIN members m ON m.id = c.member_id
       WHERE t.meeting_id IS NOT NULL AND m.subgroup_code IS NOT NULL
         AND c.category IN ('fine', 'social', 'savings')
       GROUP BY t.meeting_id, c.member_id, m.subgroup_code
       ON DUPLICATE KEY UPDATE fine = VALUES(fine), social = VALUES(social), savings = VALUES(savings)`
    );
    await connection.execute(
      `UPDATE subgroup_member_meeting_records r
       JOIN (
         SELECT lr.meeting_id, l.member_id, m.subgroup_code, SUM(lr.amount) AS loan_return
         FROM loan_repayments lr
         JOIN transactions t ON t.id = lr.transaction_id AND t.is_voided = FALSE
         JOIN loans l ON l.id = lr.loan_id
         JOIN members m ON m.id = l.member_id
         WHERE lr.meeting_id IS NOT NULL AND m.subgroup_code IS NOT NULL
         GROUP BY lr.meeting_id, l.member_id, m.subgroup_code
       ) repayment ON repayment.meeting_id = r.meeting_id
         AND repayment.member_id = r.member_id AND repayment.subgroup_code = r.subgroup_code
       SET r.loan_return = repayment.loan_return`
    );
    await connection.execute(
      `INSERT INTO subgroup_member_meeting_records (meeting_id, member_id, subgroup_code, loan_return)
       SELECT lr.meeting_id, l.member_id, m.subgroup_code, SUM(lr.amount)
       FROM loan_repayments lr
       JOIN transactions t ON t.id = lr.transaction_id AND t.is_voided = FALSE
       JOIN loans l ON l.id = lr.loan_id
       JOIN members m ON m.id = l.member_id
       WHERE lr.meeting_id IS NOT NULL AND m.subgroup_code IS NOT NULL
       GROUP BY lr.meeting_id, l.member_id, m.subgroup_code
       ON DUPLICATE KEY UPDATE loan_return = VALUES(loan_return)`
    );
    await connection.execute(
      `CREATE TABLE IF NOT EXISTS subgroup_cashbook_revisions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        meeting_id BIGINT UNSIGNED NOT NULL,
        subgroup_code CHAR(1) NOT NULL,
        fines DECIMAL(12,2) NOT NULL,
        socials DECIMAL(12,2) NOT NULL,
        savings DECIMAL(12,2) NOT NULL,
        loan_return DECIMAL(12,2) NOT NULL,
        loan_taken DECIMAL(12,2) NOT NULL,
        submitted_by BIGINT UNSIGNED NULL,
        revised_by BIGINT UNSIGNED NULL,
        revised_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_subgroup_cashbook_revision (meeting_id, subgroup_code, revised_at),
        CONSTRAINT fk_subgroup_revision_meeting FOREIGN KEY (meeting_id)
          REFERENCES meetings (id) ON DELETE CASCADE,
        CONSTRAINT fk_subgroup_revision_subgroup FOREIGN KEY (subgroup_code)
          REFERENCES subgroups (code) ON DELETE RESTRICT,
        CONSTRAINT fk_subgroup_revision_submitter FOREIGN KEY (submitted_by)
          REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_subgroup_revision_editor FOREIGN KEY (revised_by)
          REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB`
    );
    await connection.execute(
      `CREATE TABLE IF NOT EXISTS subgroup_cashbook_config (
        id TINYINT UNSIGNED NOT NULL,
        opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        effective_from DATE NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT chk_subgroup_cashbook_config_singleton CHECK (id = 1)
      ) ENGINE=InnoDB`
    );
    await connection.execute(
      `INSERT IGNORE INTO subgroup_cashbook_config (id, opening_balance, effective_from)
       SELECT 1,
         COALESCE(SUM(CASE
           WHEN transaction_type IN ('registration_fee', 'fine', 'social', 'savings', 'loan_return', 'loan_repayment', 'contribution') THEN amount
           WHEN transaction_type IN ('loan_disbursement', 'expense') THEN -amount
           ELSE 0
         END), 0),
         CURRENT_DATE
       FROM transactions
       WHERE is_voided = FALSE`
    );

    if (!(await foreignKeyExists(connection, 'fk_transactions_meeting'))) {
      await connection.execute(
        `ALTER TABLE transactions ADD CONSTRAINT fk_transactions_meeting
         FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE SET NULL`
      );
    }
    if (!(await foreignKeyExists(connection, 'fk_repayments_meeting'))) {
      await connection.execute(
        `ALTER TABLE loan_repayments ADD CONSTRAINT fk_repayments_meeting
         FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE SET NULL`
      );
    }

    console.log('Meeting and subgroup finance schema migration completed.');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Meeting finance migration failed: ${error.code || error.message}`);
  process.exitCode = 1;
});
