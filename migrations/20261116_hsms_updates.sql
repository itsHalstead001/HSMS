USE hsms;

-- Independent subgroup loan fund accounts.

CREATE TABLE IF NOT EXISTS subgroup_fund_accounts (
  subgroup_code CHAR(1) NOT NULL,
  opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (subgroup_code),
  CONSTRAINT fk_subgroup_fund_account
    FOREIGN KEY (subgroup_code)
    REFERENCES subgroups(code)
    ON DELETE RESTRICT,
  CONSTRAINT chk_subgroup_fund_balance
    CHECK (opening_balance >= 0)
) ENGINE=InnoDB;

INSERT INTO subgroup_fund_accounts
  (subgroup_code, opening_balance)
VALUES
  ('A', 0.00),
  ('B', 0.00),
  ('C', 0.00),
  ('D', 0.00)
ON DUPLICATE KEY UPDATE
  subgroup_code = VALUES(subgroup_code);

-- Monthly loan SMS notification history.

CREATE TABLE IF NOT EXISTS loan_sms_reminders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loan_id BIGINT UNSIGNED NOT NULL,
  reminder_month CHAR(7) NOT NULL,
  status ENUM('pending', 'sent', 'failed')
    NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  sent_at DATETIME NULL,
  last_error TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_loan_month (loan_id, reminder_month),
  CONSTRAINT fk_loan_sms_reminder
    FOREIGN KEY (loan_id)
    REFERENCES loans(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;