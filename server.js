require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
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
