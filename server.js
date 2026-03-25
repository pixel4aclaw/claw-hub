require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const os = require('os');
const fs = require('fs');
const v8 = require('v8');
const { execSync } = require('child_process');
const { getDb, all, get, insert, run, persist } = require('./db');
const { requireAuth, setSession, getSession, clearSession, SITE_PASSWORD } = require('./auth');
const { startWorker, getRateLimitedUntil } = require('./worker');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// ── Request logging ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'test') {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path !== '/api/health')
        console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    });
  }
  next();
});

// ── Simple in-memory rate limiter ────────────────────────────────────────────
const rateLimits = new Map();
function rateLimit({ windowMs = 60000, max = 60 } = {}) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const entry = rateLimits.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    rateLimits.set(key, entry);
    if (entry.count > max) return res.status(429).json({ error: 'too many requests' });
    next();
  };
}
// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimits) { if (now > v.reset) rateLimits.delete(k); }
}, 300000).unref();

app.use(express.json());
app.use(cookieParser());

// Apply rate limits before auth (skipped in test mode)
if (process.env.NODE_ENV !== 'test') {
  app.use('/api/login', rateLimit({ windowMs: 60000, max: 10 }));
  app.use('/api/chat',  rateLimit({ windowMs: 60000, max: 20 }));
  app.use('/api/blog',  rateLimit({ windowMs: 3600000, max: 10 }));
  app.use('/api/repos', rateLimit({ windowMs: 60000, max: 20 }));
}

// Health check before auth so monitoring tools can reach it
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), connections: io.engine.clientsCount });
});

app.use(requireAuth);

// ─── Auth routes ─────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (getSession(req)?.username) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const { password, username } = req.body;
  if (!password || !username?.trim()) {
    return res.status(400).json({ error: 'password and username required' });
  }
  if (password !== SITE_PASSWORD) {
    return res.status(401).json({ error: 'wrong password' });
  }

  const name = username.trim().toLowerCase();
  await getDb();

  let user = get('SELECT * FROM users WHERE username = ?', [name]);
  const isNew = !user;

  if (isNew) {
    const userId = insert('INSERT INTO users (username) VALUES (?)', [name]);
    user = { id: userId, username: name };
  }

  setSession(res, name);
  res.json({ ok: true, username: name, isNew });
});

app.post('/api/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// ─── Static files ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/me', async (req, res) => {
  await getDb();
  const user = get('SELECT id, username, created_at FROM users WHERE username = ?', [req.user]);
  res.json(user || { error: 'not found' });
});

// ── Users ─────────────────────────────────────────────────────────────────────

app.get('/api/users', async (req, res) => {
  await getDb();
  const users = all(`
    SELECT u.id, u.username, u.created_at, u.last_seen_at,
           (SELECT COUNT(*) FROM messages WHERE user_id = u.id AND role = 'user') as message_count
    FROM users u
    ORDER BY u.created_at ASC
  `);
  res.json(users);
});

// ── Chat / queue ──────────────────────────────────────────────────────────────

app.get('/api/messages', async (req, res) => {
  await getDb();
  const user = get('SELECT id FROM users WHERE username = ?', [req.user]);
  if (!user) return res.json([]);
  const messages = all(
    'SELECT role, content, created_at FROM messages WHERE user_id = ? ORDER BY created_at ASC',
    [user.id]
  );
  res.json(messages);
});

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  await getDb();
  const user = get('SELECT id FROM users WHERE username = ?', [req.user]);
  if (!user) return res.status(404).json({ error: 'user not found' });

  run(`UPDATE users SET last_seen_at = strftime('%s','now') WHERE id = ?`, [user.id]);

  const msgId = insert(
    'INSERT INTO messages (user_id, role, content) VALUES (?,?,?)',
    [user.id, 'user', message.trim()]
  );

  insert(
    'INSERT INTO queue (user_id, message_id) VALUES (?,?)',
    [user.id, msgId]
  );

  const position = (get(
    'SELECT COUNT(*) as c FROM queue WHERE status IN (\'pending\',\'processing\') AND id < (SELECT MAX(id) FROM queue WHERE user_id = ?)',
    [user.id]
  ) || {}).c || 0;

  io.to(`user:${req.user}`).emit('queue_update', { position });

  // If already quota-throttled, notify immediately so user sees status without waiting for next tick
  const rlc = getRateLimitCache();
  if (rlc && (rlc.five_hour.utilization > 0.80 || rlc.seven_day.utilization > 0.90)) {
    const resetSec = Math.max(rlc.five_hour.reset || 0, rlc.seven_day.reset || 0);
    const resetMs = resetSec * 1000;
    const reason = rlc.seven_day.utilization > 0.90 ? '7-day' : '5-hour';
    const pct = rlc.seven_day.utilization > 0.90
      ? Math.round(rlc.seven_day.utilization * 100)
      : Math.round(rlc.five_hour.utilization * 100);
    const resetStr = resetMs > Date.now()
      ? new Date(resetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'soon';
    io.to(`user:${req.user}`).emit('quota_throttled', {
      resetAt: resetMs,
      message: `⏸ Chat is throttled — ${reason} quota at ${pct}%. Your message is saved and will auto-send after the limit resets at ${resetStr}.`,
    });
  }

  res.json({ ok: true, queuePosition: position });
});

// ── Retry last failed message ─────────────────────────────────────────────────

app.post('/api/chat/retry', async (req, res) => {
  await getDb();
  const user = get('SELECT id FROM users WHERE username = ?', [req.user]);
  if (!user) return res.status(404).json({ error: 'user not found' });

  // Find the most recent errored queue item for this user
  const errored = get(
    "SELECT q.id, q.message_id FROM queue q WHERE q.user_id = ? AND q.status = 'error' ORDER BY q.id DESC LIMIT 1",
    [user.id]
  );
  if (!errored) return res.status(404).json({ error: 'no failed message to retry' });

  // Reset it to pending
  run("UPDATE queue SET status = 'pending', started_at = NULL, completed_at = NULL WHERE id = ?", [errored.id]);

  const position = (get(
    "SELECT COUNT(*) as c FROM queue WHERE status IN ('pending','processing') AND id < ?",
    [errored.id]
  ) || {}).c || 0;

  io.to(`user:${req.user}`).emit('queue_update', { position });
  res.json({ ok: true, queuePosition: position });
});

// ── Queue status (so frontend can restore indicator on refresh) ──────────────

app.get('/api/queue-status', async (req, res) => {
  await getDb();
  const user = get('SELECT id FROM users WHERE username = ?', [req.user]);
  if (!user) return res.json({ active: false });
  const item = get(
    "SELECT id, status, created_at FROM queue WHERE user_id = ? AND status IN ('pending','processing') ORDER BY id DESC LIMIT 1",
    [user.id]
  );
  if (!item) return res.json({ active: false });
  const position = (get(
    "SELECT COUNT(*) as c FROM queue WHERE status IN ('pending','processing') AND id < ?",
    [item.id]
  ) || {}).c || 0;
  res.json({ active: true, position, created_at: item.created_at });
});

// ── Mail (for Claw push messages and user relays) ────────────────────────────

app.get('/api/mail', async (req, res) => {
  await getDb();
  const user = get('SELECT id FROM users WHERE username = ?', [req.user]);
  if (!user) return res.json([]);
  const mail = all(`
    SELECT m.*, u.username as from_username
    FROM mail m
    LEFT JOIN users u ON m.from_user_id = u.id
    WHERE m.to_user_id = ?
    ORDER BY m.created_at DESC
  `, [user.id]);
  res.json(mail);
});

// Claw broadcasts or sends targeted messages
app.post('/api/mail/broadcast', async (req, res) => {
  const { subject, body, to } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'body required' });

  await getDb();
  const recipients = to
    ? [get('SELECT id, username FROM users WHERE username = ?', [to.toLowerCase()])].filter(Boolean)
    : all('SELECT id, username FROM users');

  for (const r of recipients) {
    insert(
      'INSERT INTO mail (from_user_id, to_user_id, subject, body, from_claw) VALUES (?,?,?,?,1)',
      [null, r.id, (subject || '').trim(), body.trim()]
    );
    io.to(`user:${r.username}`).emit('new_mail', {
      from_username: 'claw',
      from_claw: true,
      subject: (subject || '').trim(),
      body: body.trim(),
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  res.json({ ok: true, sent: recipients.length });
});

// Relay a message from one user to another (used by Claw)
app.post('/api/mail/relay', async (req, res) => {
  const { from, to, body } = req.body;
  if (!from || !to || !body?.trim()) return res.status(400).json({ error: 'from, to, and body required' });

  await getDb();
  const sender = get('SELECT id, username FROM users WHERE username = ?', [from.toLowerCase()]);
  const recipient = get('SELECT id, username FROM users WHERE username = ?', [to.toLowerCase()]);
  if (!sender || !recipient) return res.status(404).json({ error: 'user not found' });

  insert(
    'INSERT INTO mail (from_user_id, to_user_id, subject, body) VALUES (?,?,?,?)',
    [sender.id, recipient.id, '', body.trim()]
  );

  io.to(`user:${recipient.username}`).emit('new_mail', {
    from_username: sender.username,
    from_claw: false,
    body: body.trim(),
    created_at: Math.floor(Date.now() / 1000),
  });

  res.json({ ok: true });
});

// ── Rate limit polling ───────────────────────────────────────────────────────

let rateLimitCache = null;
function getRateLimitCache() { return rateLimitCache; }

async function pollRateLimits() {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const token = creds.oauthAccessToken || creds.claudeAiOauth?.accessToken;
    if (!token) return;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
    });

    const h = (name) => res.headers.get(name);
    const now = Date.now();

    rateLimitCache = {
      status: h('anthropic-ratelimit-unified-status') || 'unknown',
      tier: creds.rateLimitTier || 'unknown',
      five_hour: {
        utilization: parseFloat(h('anthropic-ratelimit-unified-5h-utilization')) || 0,
        status: h('anthropic-ratelimit-unified-5h-status') || 'unknown',
        reset: parseInt(h('anthropic-ratelimit-unified-5h-reset')) || 0,
      },
      seven_day: {
        utilization: parseFloat(h('anthropic-ratelimit-unified-7d-utilization')) || 0,
        status: h('anthropic-ratelimit-unified-7d-status') || 'unknown',
        reset: parseInt(h('anthropic-ratelimit-unified-7d-reset')) || 0,
      },
      fallback_pct: parseFloat(h('anthropic-ratelimit-unified-fallback-percentage')) || 0,
      polled_at: now,
    };
  } catch (e) {
    if (process.env.NODE_ENV !== 'test')
      console.error('[rate-limit-poll]', e.message);
  }
}

// Poll every 10 minutes (skip in test mode)
if (process.env.NODE_ENV !== 'test') {
  pollRateLimits();
  setInterval(pollRateLimits, 600000).unref();
}

// ── Status ────────────────────────────────────────────────────────────────────

function readSys(filePath, transform) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return transform ? transform(raw) : raw;
  } catch { return null; }
}

function readProcSelfIo() {
  try {
    const raw = fs.readFileSync('/proc/self/io', 'utf8');
    const obj = {};
    for (const line of raw.split('\n')) {
      const [k, v] = line.split(':').map(s => s.trim());
      if (k && v) obj[k] = parseInt(v);
    }
    return obj;
  } catch { return null; }
}

function getDiskUsage() {
  try {
    const out = execSync('df -k /data 2>/dev/null', { timeout: 3000 }).toString();
    const lines = out.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].split(/\s+/);
    return {
      total_gb: Math.round(parseInt(parts[1]) / 1024 / 1024 * 10) / 10,
      used_gb:  Math.round(parseInt(parts[2]) / 1024 / 1024 * 10) / 10,
      free_gb:  Math.round(parseInt(parts[3]) / 1024 / 1024 * 10) / 10,
      pct: parseInt(parts[4]),
    };
  } catch { return null; }
}

function getNetworkInfo() {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name === 'lo' || name === 'dummy0') continue;
    const ipv4 = addrs.find(a => a.family === 'IPv4');
    if (ipv4) result.push({ name, address: ipv4.address, internal: ipv4.internal });
  }
  return result;
}

function getOpenFds() {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch { return null; }
}

app.get('/api/status', async (req, res) => {
  await getDb();

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Android thermal zones
  const temps = [];
  for (let i = 0; i < 10; i++) {
    const t = readSys(`/sys/class/thermal/thermal_zone${i}/temp`, v => Math.round(parseInt(v) / 1000));
    if (t !== null && t > 0 && t < 150) temps.push(t);
  }

  const battery = {
    capacity: readSys('/sys/class/power_supply/battery/capacity', v => parseInt(v)),
    status: readSys('/sys/class/power_supply/battery/status'),
  };

  // V8 heap stats
  const heap = v8.getHeapStatistics();
  const procMem = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  // Process I/O
  const procIo = readProcSelfIo();

  // Disk
  const disk = getDiskUsage();

  // Network
  const network = getNetworkInfo();

  // Open file descriptors
  const openFds = getOpenFds();

  // DB stats
  const userCount = (get('SELECT COUNT(*) as c FROM users') || {}).c || 0;
  const msgCount  = (get('SELECT COUNT(*) as c FROM messages WHERE role = ?', ['user']) || {}).c || 0;
  const repoCount = (get('SELECT COUNT(*) as c FROM repos') || {}).c || 0;
  const postCount = (get('SELECT COUNT(*) as c FROM blog_posts') || {}).c || 0;
  const queuePending = (get("SELECT COUNT(*) as c FROM queue WHERE status IN ('pending','processing')") || {}).c || 0;
  const queueDone = (get("SELECT COUNT(*) as c FROM queue WHERE status = 'done'") || {}).c || 0;
  const mailCount = (get('SELECT COUNT(*) as c FROM mail') || {}).c || 0;

  res.json({
    server: {
      uptime: Math.floor(process.uptime()),
      connections: io.engine.clientsCount,
      node: process.version,
      platform: os.platform(),
      pid: process.pid,
    },
    process: {
      memory: {
        rss_mb: Math.round(procMem.rss / 1024 / 1024 * 10) / 10,
        heap_used_mb: Math.round(procMem.heapUsed / 1024 / 1024 * 10) / 10,
        heap_total_mb: Math.round(procMem.heapTotal / 1024 / 1024 * 10) / 10,
        external_mb: Math.round(procMem.external / 1024 / 1024 * 10) / 10,
      },
      heap: {
        used_mb: Math.round(heap.used_heap_size / 1024 / 1024 * 10) / 10,
        limit_mb: Math.round(heap.heap_size_limit / 1024 / 1024),
        pct: Math.round((heap.used_heap_size / heap.heap_size_limit) * 100),
        native_contexts: heap.number_of_native_contexts,
        detached_contexts: heap.number_of_detached_contexts,
      },
      cpu: {
        user_ms: Math.round(cpuUsage.user / 1000),
        system_ms: Math.round(cpuUsage.system / 1000),
      },
      io: procIo ? {
        read_mb: Math.round(procIo.read_bytes / 1024 / 1024 * 10) / 10,
        write_mb: Math.round(procIo.write_bytes / 1024 / 1024 * 10) / 10,
        syscalls_r: procIo.syscr,
        syscalls_w: procIo.syscw,
      } : null,
      open_fds: openFds,
    },
    system: {
      hostname: os.hostname(),
      arch: os.arch(),
      kernel: os.release(),
      uptime: Math.floor(os.uptime()),
      cpus: os.availableParallelism?.() || os.cpus().length || null,
      load: os.loadavg().map(l => Math.round(l * 100) / 100),
      memory: {
        total_mb: Math.round(totalMem / 1024 / 1024),
        used_mb: Math.round(usedMem / 1024 / 1024),
        free_mb: Math.round(freeMem / 1024 / 1024),
        pct: Math.round((usedMem / totalMem) * 100),
      },
      disk,
      network,
      temps_c: temps,
      battery,
    },
    stats: {
      users: userCount,
      messages: msgCount,
      repos: repoCount,
      blog_posts: postCount,
      mail: mailCount,
      queue_pending: queuePending,
      queue_done: queueDone,
    },
    rateLimit: rateLimitCache,
    git: getGitActivity(),
  });
});

function getGitActivity() {
  try {
    const log = execSync(
      'git log --all -15 --pretty=format:"%h|%s|%an|%ar" --no-merges',
      { cwd: __dirname, timeout: 5000 }
    ).toString().trim();
    if (!log) return { commits: [], branch: null, totalCommits: 0 };
    const commits = log.split('\n').filter(Boolean).map(line => {
      const [hash, message, author, ago] = line.split('|');
      return { hash, message, author, ago };
    });
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname, timeout: 3000 }).toString().trim();
    const totalRaw = execSync('git rev-list --count HEAD', { cwd: __dirname, timeout: 3000 }).toString().trim();
    return { commits, branch, totalCommits: parseInt(totalRaw) || 0 };
  } catch { return { commits: [], branch: null, totalCommits: 0 }; }
}

// ── Repos ─────────────────────────────────────────────────────────────────────

app.get('/api/repos', async (req, res) => {
  await getDb();
  const repos = all(`
    SELECT r.*, u.username
    FROM repos r
    JOIN users u ON r.user_id = u.id
    ORDER BY r.created_at DESC
  `);
  res.json(repos);
});

app.post('/api/repos', async (req, res) => {
  const { name, description, repo_url, site_url } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });

  await getDb();
  const user = get('SELECT id FROM users WHERE username = ?', [req.user]);
  if (!user) return res.status(404).json({ error: 'user not found' });

  const id = insert(
    'INSERT INTO repos (user_id, name, description, repo_url, site_url) VALUES (?,?,?,?,?)',
    [user.id, name.trim(), (description || '').trim(), (repo_url || '').trim(), (site_url || '').trim()]
  );

  const repo = get('SELECT r.*, u.username FROM repos r JOIN users u ON r.user_id = u.id WHERE r.id = ?', [id]);
  io.emit('new_repo', repo);
  res.json({ ok: true, repo });
});

app.delete('/api/repos/:id', async (req, res) => {
  await getDb();
  const user = get('SELECT id FROM users WHERE username = ?', [req.user]);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const repo = get('SELECT * FROM repos WHERE id = ?', [req.params.id]);
  if (!repo) return res.status(404).json({ error: 'not found' });
  if (repo.user_id !== user.id) return res.status(403).json({ error: 'not yours' });
  run('DELETE FROM repos WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ── Blog ──────────────────────────────────────────────────────────────────────

app.get('/api/blog', async (req, res) => {
  await getDb();
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = parseInt(req.query.offset) || 0;
  const posts = all(
    'SELECT * FROM blog_posts ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );
  res.json(posts);
});

app.post('/api/blog', async (req, res) => {
  const { title, body, topic } = req.body;
  if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: 'title and body required' });

  await getDb();
  const id = insert(
    'INSERT INTO blog_posts (title, body, topic) VALUES (?,?,?)',
    [title.trim(), body.trim(), (topic || '').trim()]
  );

  const post = get('SELECT * FROM blog_posts WHERE id = ?', [id]);
  io.emit('new_blog_post', post);
  res.json({ ok: true, post });
});

// ─── Socket.io ───────────────────────────────────────────────────────────────

// ── Global async error handler ───────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal server error' });
  }
});

// ─── Socket.io ───────────────────────────────────────────────────────────────

io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';')
      .map(c => c.trim().split('='))
      .filter(p => p.length >= 2)
      .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('=').trim())])
  );
  const req = { cookies };
  const session = getSession(req);
  if (!session?.username) return next(new Error('unauthorized'));
  socket.username = session.username;
  next();
});

io.on('connection', (socket) => {
  console.log(`[+] ${socket.username} connected (${socket.id})`);
  socket.join(`user:${socket.username}`);
  socket.emit('welcome', { message: 'Connected to Claw Hub', username: socket.username });

  // Track presence — update last_seen_at on connect
  run(`UPDATE users SET last_seen_at = strftime('%s','now') WHERE username = ?`, [socket.username]);
  io.emit('presence_update', { username: socket.username, last_seen_at: Math.floor(Date.now() / 1000) });

  socket.on('ping', () => socket.emit('pong', { time: Date.now() }));
  socket.on('disconnect', () => console.log(`[-] ${socket.username} disconnected`));
});

// ── Commit watcher bot (all repos in pixel4aclaw account) ─────────────────────

const GITHUB_USER = 'pixel4aclaw';
const seenCommitIds = new Set(); // track seen push event IDs to avoid dupes
let localLastHash = null;        // still track local repo for instant detection

function startCommitWatcher() {
  // ── Local repo watcher (instant, 5s poll) ──
  try {
    localLastHash = execSync('git rev-parse HEAD', { cwd: __dirname, timeout: 5000 }).toString().trim();
  } catch (e) {
    console.error('[commit-watcher] failed to get initial local hash:', e.message);
  }

  setInterval(() => {
    try {
      const currentHash = execSync('git rev-parse HEAD', { cwd: __dirname, timeout: 5000 }).toString().trim();
      if (localLastHash && currentHash !== localLastHash) {
        const log = execSync(
          `git log ${localLastHash}..${currentHash} --pretty=format:"%h|%s|%an" --reverse`,
          { cwd: __dirname, timeout: 5000 }
        ).toString().trim();

        const commits = log.split('\n').filter(Boolean).map(line => {
          const [hash, message, author] = line.split('|');
          return { hash, message, author, repo: 'claw-hub' };
        });

        for (const commit of commits) {
          const id = `local-${commit.hash}`;
          if (!seenCommitIds.has(id)) {
            seenCommitIds.add(id);
            console.log(`[commit-watcher] 🚀 ${commit.repo} ${commit.hash} ${commit.message} by ${commit.author}`);
            io.emit('new_commit', commit);
          }
        }
      }
      localLastHash = currentHash;
    } catch (e) { /* mid-commit, ignore */ }
  }, 5000).unref();

  // ── GitHub Events API watcher (all repos, 30s poll) ──
  // Covers every repo in the account including ones created after server start
  let ghInitialized = false;

  setInterval(async () => {
    try {
      const raw = execSync(
        `gh api users/${GITHUB_USER}/events --jq '[.[] | select(.type=="PushEvent")] | .[0:20]'`,
        { timeout: 15000 }
      ).toString().trim();

      if (!raw || raw === '[]') return;
      const events = JSON.parse(raw);

      // On first run, just seed the seen set — don't spam old commits
      if (!ghInitialized) {
        for (const ev of events) seenCommitIds.add(ev.id);
        ghInitialized = true;
        console.log(`[commit-watcher] GitHub watcher initialized, seeded ${events.length} events`);
        return;
      }

      for (const ev of events) {
        if (seenCommitIds.has(ev.id)) continue;
        seenCommitIds.add(ev.id);

        const repoName = (ev.repo?.name || '').replace(`${GITHUB_USER}/`, '');
        const commits = (ev.payload?.commits || []);

        for (const c of commits) {
          const shortHash = (c.sha || '').slice(0, 7);
          const dedupKey = `gh-${shortHash}`;
          if (seenCommitIds.has(dedupKey)) continue; // skip if local watcher already caught it
          seenCommitIds.add(dedupKey);

          const commit = {
            hash: shortHash,
            message: c.message || '',
            author: c.author?.name || ev.actor?.login || 'unknown',
            repo: repoName
          };
          console.log(`[commit-watcher] 🚀 ${commit.repo} ${commit.hash} ${commit.message} by ${commit.author}`);
          io.emit('new_commit', commit);
        }
      }

      // Prune seenCommitIds if it gets too large (keep last 500)
      if (seenCommitIds.size > 500) {
        const arr = [...seenCommitIds];
        arr.splice(0, arr.length - 300);
        seenCommitIds.clear();
        arr.forEach(id => seenCommitIds.add(id));
      }
    } catch (e) {
      // gh CLI might fail if rate-limited or offline — silently retry next cycle
    }
  }, 30000).unref(); // Poll GitHub every 30 seconds

  console.log(`[commit-watcher] watching local repo + all ${GITHUB_USER} GitHub repos`);
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────

async function start(port) {
  await getDb();
  return new Promise(resolve => {
    server.listen(port ?? PORT, '0.0.0.0', () => {
      if (process.env.NODE_ENV !== 'test') {
        console.log(`Claw Hub running on http://0.0.0.0:${server.address().port}`);
        startCommitWatcher();
      }
      startWorker(io, getRateLimitCache);
      resolve(server);
    });
  });
}

function stop() {
  return new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  // If rate-limited, park any processing items so they survive the restart
  const rateLimitedUntil = getRateLimitedUntil();
  if (rateLimitedUntil > Date.now()) {
    const blockedUntilSec = Math.ceil(rateLimitedUntil / 1000);
    const stale = all(`SELECT id FROM queue WHERE status = 'processing'`, []);
    for (const s of stale) {
      run("UPDATE queue SET status = 'pending', started_at = NULL, blocked_until = ? WHERE id = ?", [blockedUntilSec, s.id]);
      console.log(`[${signal}] parked item ${s.id} with blocked_until=${new Date(rateLimitedUntil).toISOString()}`);
    }
  }
  persist();
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  setTimeout(() => { console.error('Forced exit.'); process.exit(1); }, 8000).unref();
}

if (require.main === module) {
  // Intercept process.exit to trace what's calling it
  const _origExit = process.exit.bind(process);
  process.exit = function(code) {
    console.error(`[process.exit] called with code=${code}`, new Error().stack);
    _origExit(code);
  };

  start().catch(console.error);
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // SIGINT is ignored — the claude binary sends SIGINT to the process group
  // when it exits, which was killing the server. pm2 uses SIGTERM for shutdown.
  process.on('SIGINT', () => {
    console.log('[SIGINT] Ignored (claude subprocess signal leak)');
  });
  process.on('SIGQUIT', () => console.log('[signal] SIGQUIT received — ignored'));
  // Hook server close to trace who closes it
  server.on('close', () => console.error('[server] HTTP server closed — this will drain event loop!', new Error().stack));
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.stack || err.message || err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason?.stack || reason?.message || reason);
  });
  process.on('exit', (code) => {
    console.error(`[exit] code=${code} server.listening=${server.listening} clients=${io?.engine?.clientsCount ?? '?'}`);
    console.error(`[exit] active handles:`, process._getActiveHandles().length, 'requests:', process._getActiveRequests().length);
  });
  process.on('SIGHUP', () => console.log('[signal] SIGHUP received'));
  process.on('SIGUSR1', () => console.log('[signal] SIGUSR1 received'));
  process.on('SIGUSR2', () => console.log('[signal] SIGUSR2 received'));

  // Safety net: keep-alive timer prevents event loop drain.
  // The HTTP server should do this, but something lets the loop die after agent calls.
  setInterval(() => {}, 30000);
}

module.exports = { app, server, io, start, stop, rateLimit };
