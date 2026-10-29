// SQLite store shared by the daemon, the hook script and the factory MCP server.
// WAL mode lets several processes read while one writes; every table bumps kv.change_seq
// through triggers so the dashboard can refresh when anything changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { DB_PATH } from './paths.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO kv (key, value) VALUES ('change_seq', '0');

CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  area TEXT,
  kind TEXT NOT NULL DEFAULT 'feature',
  task_type TEXT,
  origin TEXT NOT NULL,
  origin_role TEXT,
  origin_run_id TEXT,
  parent_id INTEGER,
  status TEXT NOT NULL DEFAULT 'inbox',
  approval TEXT NOT NULL DEFAULT 'pending',
  approval_reason TEXT,
  owner_role TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  needs_spec INTEGER NOT NULL DEFAULT 0,
  spec_path TEXT,
  pass_label TEXT,
  rework_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  rating TEXT,
  rating_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  shipped_at TEXT
);
CREATE INDEX IF NOT EXISTS ideas_status ON ideas(status);

CREATE TABLE IF NOT EXISTS idea_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idea_events_idea ON idea_events(idea_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  role TEXT,
  agent_type TEXT,
  idea_id INTEGER,
  loop_id TEXT,
  session_id TEXT,
  resumed_from TEXT,
  model TEXT,
  model_why TEXT,
  task_type TEXT,
  status TEXT NOT NULL,
  purpose TEXT,
  prompt TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_activity_at TEXT,
  progress INTEGER,
  progress_note TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  num_turns INTEGER,
  result_text TEXT,
  error TEXT,
  transcript_path TEXT,
  transcript_offset INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  owner_action INTEGER NOT NULL DEFAULT 0,
  rating TEXT,
  redo_reason TEXT,
  rating_note TEXT
);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS runs_idea ON runs(idea_id);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  role TEXT,
  kind TEXT NOT NULL,
  tool_name TEXT,
  summary TEXT NOT NULL DEFAULT '',
  files TEXT
);
CREATE INDEX IF NOT EXISTS activity_run ON activity(run_id);
CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts);

CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  holder_key TEXT NOT NULL,
  holder_kind TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  role TEXT,
  reason TEXT,
  idea_id INTEGER,
  claimed_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);
CREATE INDEX IF NOT EXISTS holds_live ON holds(resource_id, released_at);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  holder_key TEXT NOT NULL,
  run_id TEXT,
  role TEXT,
  reason TEXT,
  idea_id INTEGER,
  requested_at TEXT NOT NULL,
  UNIQUE(resource_id, holder_key)
);

CREATE TABLE IF NOT EXISTS file_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  holder_key TEXT NOT NULL,
  run_id TEXT,
  role TEXT,
  reason TEXT,
  claimed_at TEXT NOT NULL,
  released_at TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  session_id TEXT,
  role TEXT,
  idea_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'question',
  text TEXT NOT NULL,
  choices TEXT,
  blocking INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  handled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS questions_status ON questions(status);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  run_id TEXT,
  text TEXT NOT NULL,
  delivered_at TEXT,
  delivered_run_id TEXT
);
CREATE INDEX IF NOT EXISTS messages_to ON messages(to_role, delivered_at);

CREATE TABLE IF NOT EXISTS loop_state (
  loop_id TEXT PRIMARY KEY,
  enabled INTEGER,
  last_fired_at TEXT,
  last_run_id TEXT,
  last_status TEXT,
  last_summary TEXT
);

CREATE TABLE IF NOT EXISTS routing_overrides (
  task_type TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  why TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  improvement_id INTEGER
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  tasks TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL,
  run_id TEXT,
  owner_note TEXT,
  idea_ids TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS improvements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  files TEXT,
  commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'applied',
  actor TEXT NOT NULL,
  run_id TEXT
);
`;

// Columns added after the first release; each is applied once (a duplicate column error means done).
const MIGRATIONS = [
  'ALTER TABLE ideas ADD COLUMN depends_on TEXT',
  'ALTER TABLE ideas ADD COLUMN rank INTEGER',
  'UPDATE ideas SET rank = id * 10 WHERE rank IS NULL',
  "ALTER TABLE ideas ADD COLUMN level TEXT NOT NULL DEFAULT 'task'",
  'ALTER TABLE ideas ADD COLUMN standing INTEGER NOT NULL DEFAULT 0',
];

const WATCHED = ['ideas', 'idea_events', 'runs', 'activity', 'holds', 'queue', 'file_claims', 'questions',
  'messages', 'loop_state', 'routing_overrides', 'improvements', 'proposals'];

function triggers() {
  const out = [];
  for (const t of WATCHED) {
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      out.push(`CREATE TRIGGER IF NOT EXISTS ${t}_${op.toLowerCase()}_seq AFTER ${op} ON ${t}
        BEGIN UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'change_seq'; END;`);
    }
  }
  return out.join('\n');
}

export function openDb(file = DB_PATH, { readonly = false } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly });
  db.pragma('busy_timeout = 5000');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(SCHEMA);
    for (const m of MIGRATIONS) { try { db.exec(m); } catch { /* already applied */ } }
    db.exec(triggers());
  }
  return db;
}

export const now = () => new Date().toISOString();

export function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

export function kvGet(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function kvSet(db, key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function changeSeq(db) {
  return Number(kvGet(db, 'change_seq', '0'));
}

export function logActivity(db, { runId = null, sessionId = null, role = null, kind, toolName = null, summary = '', files = null }) {
  db.prepare(`INSERT INTO activity (ts, run_id, session_id, role, kind, tool_name, summary, files)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(now(), runId, sessionId, role, kind, toolName, String(summary).slice(0, 400), files ? JSON.stringify(files) : null);
}

// Local-day start as ISO, for "today" totals.
export function startOfToday(d = new Date()) {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s.toISOString();
}

// "Billable" tokens: input + output + cache writes. Cache reads are cheap and huge, so they
// are shown but not counted against the budget.
export function tokensUsedSince(db, sinceIso) {
  const r = db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens + cache_write), 0) AS t
    FROM runs WHERE started_at >= ?`).get(sinceIso);
  return r.t;
}
