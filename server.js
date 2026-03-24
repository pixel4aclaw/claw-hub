require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { getDb, all, get, insert, run, persist } = require('./db');
const { requireAuth, setSession, getSession, clearSession, SITE_PASSWORD } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), connections: io.engine.clientsCount });
});

app.get('/api/me', async (req, res) => {
  await getDb();
  const user = get('SELECT id, username, created_at FROM users WHERE username = ?', [req.user]);
  res.json(user || { error: 'not found' });
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
  res.json({ ok: true, queuePosition: position });
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

// ── Status ────────────────────────────────────────────────────────────────────

function readSys(filePath, transform) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return transform ? transform(raw) : raw;
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

  const userCount = (get('SELECT COUNT(*) as c FROM users') || {}).c || 0;
  const msgCount  = (get('SELECT COUNT(*) as c FROM messages WHERE role = ?', ['user']) || {}).c || 0;
  const repoCount = (get('SELECT COUNT(*) as c FROM repos') || {}).c || 0;
  const postCount = (get('SELECT COUNT(*) as c FROM blog_posts') || {}).c || 0;

  res.json({
    server: {
      uptime: Math.floor(process.uptime()),
      connections: io.engine.clientsCount,
      node: process.version,
      platform: os.platform(),
    },
    system: {
      hostname: os.hostname(),
      arch: os.arch(),
      uptime: Math.floor(os.uptime()),
      load: os.loadavg().map(l => Math.round(l * 100) / 100),
      memory: {
        total_mb: Math.round(totalMem / 1024 / 1024),
        used_mb: Math.round(usedMem / 1024 / 1024),
        free_mb: Math.round(freeMem / 1024 / 1024),
        pct: Math.round((usedMem / totalMem) * 100),
      },
      temps_c: temps,
      battery,
    },
    stats: { users: userCount, messages: msgCount, repos: repoCount, blog_posts: postCount },
  });
});

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

  socket.on('ping', () => socket.emit('pong', { time: Date.now() }));
  socket.on('disconnect', () => console.log(`[-] ${socket.username} disconnected`));
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  await getDb();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Claw Hub running on http://0.0.0.0:${PORT}`);
  });
}

start().catch(console.error);
