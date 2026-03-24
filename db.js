const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'claw.db');

let db = null;

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  // Ensure data dir exists
  if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  }

  // Load existing DB or create new
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
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      building_type TEXT,
      building_description TEXT,
      building_page_html TEXT,
      onboarded INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS buildings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      type TEXT,
      description TEXT,
      x REAL DEFAULT 0,
      y REAL DEFAULT 0,
      width REAL DEFAULT 120,
      height REAL DEFAULT 100,
      page_html TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
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
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS town_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
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
  `);

  // Seed town hall
  db.run(`INSERT OR IGNORE INTO town_state (key, value) VALUES ('town_name', '"Claw Town"')`);
  db.run(`INSERT OR IGNORE INTO town_state (key, value) VALUES ('town_rules', '[]')`);
  db.run(`INSERT OR IGNORE INTO town_state (key, value) VALUES ('town_hall_pos', '{"x":0,"y":0}')`);
}

// Run migrations for existing DBs
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
    persist();
  } catch (e) {
    console.error('[db] migration error:', e.message);
  }
}

// Write DB to disk
function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Helper: run a write + persist
function run(sql, params = []) {
  getDb(); // ensure loaded (sync check)
  db.run(sql, params);
  persist();
}

// Helper: query rows as objects
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

// Helper: get single row
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

// Helper: get last insert rowid
function insert(sql, params = []) {
  db.run(sql, params);
  const result = all('SELECT last_insert_rowid() as id');
  persist();
  return result[0]?.id;
}

module.exports = { getDb, persist, run, all, get, insert, initSchema, migrate };
