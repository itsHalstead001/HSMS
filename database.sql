CREATE DATABASE IF NOT EXISTS hsms
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE hsms;

CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT NOT NULL,
  PRIMARY KEY (session_id),
  KEY idx_sessions_expires (expires)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subgroups (
  code CHAR(1) NOT NULL,
  name VARCHAR(80) NOT NULL,
  PRIMARY KEY (code),
  CONSTRAINT chk_subgroups_code CHECK (code IN ('A', 'B', 'C', 'D'))
) ENGINE=InnoDB;

INSERT INTO subgroups (code, name) VALUES
  ('A', 'Subgroup A'),
  ('B', 'Subgroup B'),
  ('C', 'Subgroup C'),
  ('D', 'Subgroup D')
ON DUPLICATE KEY UPDATE name = VALUES(name);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(80) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  role ENUM('chairperson', 'secretary', 'financial_secretary', 'treasurer', 'subgroup_chairperson', 'subgroup_secretary') NOT NULL,
  subgroup_code CHAR(1) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  KEY idx_users_role_active (role, is_active),
  KEY idx_users_subgroup (subgroup_code),
  CONSTRAINT fk_users_subgroup FOREIGN KEY (subgroup_code)
    REFERENCES subgroups (code) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(160) NOT NULL,
  phone VARCHAR(40) NULL,
  email VARCHAR(190) NULL,
  address VARCHAR(500) NULL,
  subgroup_code CHAR(1) NULL,
  join_date DATE NOT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  registration_fee_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_members_name (full_name),
  KEY idx_members_status_join_date (status, join_date),
  KEY idx_members_email (email),
  KEY idx_members_subgroup_status (subgroup_code, status),
  CONSTRAINT fk_members_subgroup FOREIGN KEY (subgroup_code)
    REFERENCES subgroups (code) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transaction_type ENUM(
    'registration_fee', 'contribution', 'fine', 'social', 'savings',
    'loan_disbursement', 'loan_repayment', 'loan_return', 'expense'
  ) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  transaction_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  description VARCHAR(500) NOT NULL,
  related_id BIGINT UNSIGNED NULL,
  meeting_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NULL,
  is_voided BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_transactions_date (transaction_date),
  KEY idx_transactions_type_date (transaction_type, transaction_date),
  KEY idx_transactions_related (transaction_type, related_id),
  KEY idx_transactions_meeting_type (meeting_id, transaction_type),
  CONSTRAINT fk_transactions_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_transactions_amount CHECK (amount > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contributions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  category ENUM('registration_fee', 'fine', 'social', 'savings') NOT NULL DEFAULT 'savings',
  contribution_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  transaction_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contributions_transaction (transaction_id),
  KEY idx_contributions_member_date (member_id, contribution_date),
  KEY idx_contributions_category_date (category, contribution_date),
  CONSTRAINT fk_contributions_member FOREIGN KEY (member_id)
    REFERENCES members (id) ON DELETE RESTRICT,
  CONSTRAINT fk_contributions_transaction FOREIGN KEY (transaction_id)
    REFERENCES transactions (id) ON DELETE RESTRICT,
  CONSTRAINT chk_contributions_amount CHECK (amount > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS loans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  interest_rate DECIMAL(7,4) NOT NULL,
  term_months SMALLINT UNSIGNED NOT NULL,
  application_date DATE NOT NULL,
  purpose VARCHAR(500) NOT NULL,
  approval_date DATE NULL,
  approved_by BIGINT UNSIGNED NULL,
  disbursed_at DATETIME NULL,
  status ENUM('pending', 'approved', 'rejected', 'active', 'repaid') NOT NULL DEFAULT 'pending',
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_loans_member_date (member_id, application_date),
  KEY idx_loans_status (status),
  CONSTRAINT fk_loans_member FOREIGN KEY (member_id)
    REFERENCES members (id) ON DELETE RESTRICT,
  CONSTRAINT fk_loans_approver FOREIGN KEY (approved_by)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_loans_amount CHECK (amount > 0),
  CONSTRAINT chk_loans_balance CHECK (balance >= 0),
  CONSTRAINT chk_loans_term CHECK (term_months > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS loan_repayments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loan_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  repayment_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  transaction_id BIGINT UNSIGNED NOT NULL,
  meeting_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_repayments_transaction (transaction_id),
  KEY idx_repayments_loan_date (loan_id, repayment_date),
  KEY idx_repayments_meeting (meeting_id),
  CONSTRAINT fk_repayments_loan FOREIGN KEY (loan_id)
    REFERENCES loans (id) ON DELETE RESTRICT,
  CONSTRAINT fk_repayments_transaction FOREIGN KEY (transaction_id)
    REFERENCES transactions (id) ON DELETE RESTRICT,
  CONSTRAINT chk_repayments_amount CHECK (amount > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS repayment_schedule (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loan_id BIGINT UNSIGNED NOT NULL,
  installment_number SMALLINT UNSIGNED NOT NULL,
  due_date DATE NOT NULL,
  amount_due DECIMAL(12,2) NOT NULL,
  amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  paid_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schedule_installment (loan_id, installment_number),
  KEY idx_schedule_due_date (due_date),
  CONSTRAINT fk_schedule_loan FOREIGN KEY (loan_id)
    REFERENCES loans (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS meetings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  meeting_date DATETIME NOT NULL,
  weekly_occurrence DATE NULL,
  description TEXT NULL,
  minutes TEXT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_meetings_date (meeting_date),
  UNIQUE KEY uq_meetings_weekly_occurrence (weekly_occurrence),
  CONSTRAINT fk_meetings_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS meeting_cashbooks (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subgroup_cashbook_submissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  subgroup_code CHAR(1) NOT NULL,
  fines DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  socials DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  savings DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  loan_return DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  loan_taken DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  submitted_by BIGINT UNSIGNED NULL,
  submitted_at DATETIME NULL,
  pending_changes BOOLEAN NOT NULL DEFAULT FALSE,
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subgroup_member_meeting_records (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subgroup_member_meeting_revisions (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subgroup_meeting_notes (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subgroup_cashbook_revisions (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subgroup_cashbook_config (
  id TINYINT UNSIGNED NOT NULL,
  opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  effective_from DATE NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_subgroup_cashbook_config_singleton CHECK (id = 1)
) ENGINE=InnoDB;

INSERT INTO subgroup_cashbook_config (id, opening_balance, effective_from)
VALUES (1, 0.00, CURRENT_DATE)
ON DUPLICATE KEY UPDATE id = VALUES(id);

CREATE TABLE IF NOT EXISTS attendance (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  status ENUM('present', 'absent', 'excused') NOT NULL DEFAULT 'present',
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_meeting_member (meeting_id, member_id),
  KEY idx_attendance_member (member_id),
  CONSTRAINT fk_attendance_meeting FOREIGN KEY (meeting_id)
    REFERENCES meetings (id) ON DELETE CASCADE,
  CONSTRAINT fk_attendance_member FOREIGN KEY (member_id)
    REFERENCES members (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  uploaded_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_documents_stored_name (stored_name),
  KEY idx_documents_created_at (created_at),
  CONSTRAINT fk_documents_user FOREIGN KEY (uploaded_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS group_settings (
  setting_key VARCHAR(80) NOT NULL,
  setting_value VARCHAR(500) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB;

INSERT INTO group_settings (setting_key, setting_value) VALUES
  ('group_name', 'Halstead Self-Help Group'),
  ('registration_fee', '0.00'),
  ('interest_rate', '12.0000'),
  ('default_loan_term_months', '12'),
  ('currency', 'KES')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);
