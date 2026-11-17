-- SQLite equivalent of db/schema.sql.
-- Timestamps are stored as 'YYYY-MM-DD HH:MM:SS' strings, matching MySQL DATETIME.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(80) NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(120) NOT NULL,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
  class_id INTEGER NULL REFERENCES classes (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_class ON users (class_id);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_text TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_index INTEGER NOT NULL,
  solution TEXT NOT NULL,
  subject VARCHAR(120) NOT NULL DEFAULT 'General',
  diagram_svg TEXT NULL,
  created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_questions_creator ON questions (created_by);

CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title VARCHAR(160) NOT NULL,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  minutes INTEGER NOT NULL,
  shuffle_questions INTEGER NOT NULL DEFAULT 0,
  is_open INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quizzes_class ON quizzes (class_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_teacher ON quizzes (teacher_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_deleted ON quizzes (is_deleted);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE ON UPDATE CASCADE,
  position INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_index INTEGER NOT NULL,
  solution TEXT NOT NULL,
  subject VARCHAR(120) NOT NULL DEFAULT 'General',
  diagram_svg TEXT NULL,
  UNIQUE (quiz_id, position)
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE ON UPDATE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('Practice', 'Exam')),
  question_order_json TEXT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'expired')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NULL,
  submitted_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_student_quiz ON quiz_attempts (student_id, quiz_id, status);
CREATE INDEX IF NOT EXISTS idx_attempts_expiry ON quiz_attempts (status, expires_at);

CREATE TABLE IF NOT EXISTS attempt_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES quiz_attempts (id) ON DELETE CASCADE ON UPDATE CASCADE,
  position INTEGER NOT NULL,
  chosen_index INTEGER NULL,
  answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (attempt_id, position)
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  attempt_id INTEGER NOT NULL UNIQUE REFERENCES quiz_attempts (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('Practice', 'Exam')),
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  pct INTEGER NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_submissions_quiz ON submissions (quiz_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions (student_id);
CREATE INDEX IF NOT EXISTS idx_submissions_class ON submissions (class_id);

CREATE TABLE IF NOT EXISTS submission_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions (id) ON DELETE CASCADE ON UPDATE CASCADE,
  position INTEGER NOT NULL,
  chosen_index INTEGER NULL,
  correct_index INTEGER NOT NULL,
  is_correct INTEGER NOT NULL,
  UNIQUE (submission_id, position)
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NULL REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  actor_name VARCHAR(120) NOT NULL,
  action VARCHAR(255) NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs (created_at);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements (created_at);

CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(64) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL
);

INSERT OR IGNORE INTO settings (setting_key, setting_value)
VALUES ('default_quiz_minutes', '45');
