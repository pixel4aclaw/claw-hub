const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH_OVERRIDE === ':memory:'
  ? null
  : path.join(__dirname, 'data', 'claw.db');

let db = null;

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  // In-memory mode (tests)
  if (!DB_PATH) {
    db = new SQL.Database();
    initSchema();
    return db;
  }

  if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  }

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    migrate();
  } else {
    db = new SQL.Database();
    initSchema();
    persist();
  }

  return db;
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      message_id INTEGER NOT NULL REFERENCES messages(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','error')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      started_at INTEGER,
      completed_at INTEGER,
      blocked_until INTEGER
    );

    CREATE TABLE IF NOT EXISTS mail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER REFERENCES users(id),
      to_user_id INTEGER NOT NULL REFERENCES users(id),
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      from_claw INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      repo_url TEXT DEFAULT '',
      site_url TEXT DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      topic TEXT DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
}

function migrate() {
  try {
    db.run(`CREATE TABLE IF NOT EXISTS mail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER REFERENCES users(id),
      to_user_id INTEGER NOT NULL REFERENCES users(id),
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      from_claw INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      repo_url TEXT DEFAULT '',
      site_url TEXT DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      topic TEXT DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);
    // Add session_id column to users table for agent SDK session resumption
    try { db.run(`ALTER TABLE users ADD COLUMN session_id TEXT`); } catch (_) {}
    // Add blocked_until to queue so rate-limited items stay parked until reset
    try { db.run(`ALTER TABLE queue ADD COLUMN blocked_until INTEGER`); } catch (_) {}
    persist();
  } catch (e) {
    console.error('[db] migration error:', e.message);
  }
}

// Immediate persist — used on shutdown and explicit flush
function persist() {
  if (!db || !DB_PATH) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Debounced persist — coalesces rapid writes into a single disk flush
let persistTimer = null;
function debouncedPersist() {
  if (!DB_PATH) return;
  if (persistTimer) return; // already scheduled
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, 500);
}

function run(sql, params = []) {
  getDb();
  db.run(sql, params);
  debouncedPersist();
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

function insert(sql, params = []) {
  db.run(sql, params);
  const result = all('SELECT last_insert_rowid() as id');
  debouncedPersist();
  return result[0]?.id;
}

module.exports = { getDb, persist, run, all, get, insert, initSchema, migrate };
