require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const { getDb, all, get, insert, run, persist } = require('./db');
const { requireAuth, setSession, getSession, clearSession, SITE_PASSWORD } = require('./auth');
const { generateBuilding, enrichBuilding } = require('./building-gen');

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

    // Auto-generate building
    const buildingCount = (get('SELECT COUNT(*) as c FROM buildings') || {}).c || 0;
    const bld = generateBuilding(name, buildingCount);
    insert(
      'INSERT INTO buildings (user_id, name, type, description, x, y) VALUES (?,?,?,?,?,?)',
      [userId, `${name}'s ${bld.label}`, bld.type, bld.description, bld.x, bld.y]
    );

    user = { id: userId, username: name, onboarded: 0 };

    // Notify connected clients about new building
    const fullBld = enrichBuilding(get(
      'SELECT b.*, u.username FROM buildings b JOIN users u ON b.user_id = u.id WHERE u.username = ?',
      [name]
    ));
    io.emit('town_update', { type: 'new_building', building: fullBld });
  }

  setSession(res, name);
  res.json({ ok: true, username: name, isNew, onboarded: user.onboarded });
});

app.post('/api/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// ─── Static files ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── Page routes ─────────────────────────────────────────────────────────────

app.get('/town', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'town.html'));
});

app.get('/building/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'building.html'));
});

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), connections: io.engine.clientsCount });
});

app.get('/api/me', async (req, res) => {
  await getDb();
  const user = get(
    'SELECT id, username, building_type, building_description, onboarded, created_at FROM users WHERE username = ?',
    [req.user]
  );
  res.json(user || { error: 'not found' });
});

app.get('/api/town', async (req, res) => {
  await getDb();
  const state = {};
  all('SELECT key, value FROM town_state').forEach(r => {
    try { state[r.key] = JSON.parse(r.value); } catch { state[r.key] = r.value; }
  });
  const buildings = all('SELECT b.*, u.username FROM buildings b JOIN users u ON b.user_id = u.id')
    .map(enrichBuilding);
  res.json({ state, buildings });
});

app.get('/api/building/:username', async (req, res) => {
  await getDb();
  const uname = req.params.username.toLowerCase();
  const user = get('SELECT id, username, onboarded, created_at FROM users WHERE username = ?', [uname]);
  if (!user) return res.status(404).json({ error: 'not found' });
  const building = get(
    'SELECT * FROM buildings WHERE user_id = ?',
    [user.id]
  );
  if (!building) return res.status(404).json({ error: 'building not found' });
  res.json({ user, building: enrichBuilding(building) });
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

  // Store message
  const msgId = insert(
    'INSERT INTO messages (user_id, role, content) VALUES (?,?,?)',
    [user.id, 'user', message.trim()]
  );

  // Add to queue
  insert(
    'INSERT INTO queue (user_id, message_id) VALUES (?,?)',
    [user.id, msgId]
  );

  // Queue position (count pending items ahead of this one)
  const position = (get(
    'SELECT COUNT(*) as c FROM queue WHERE status IN (\'pending\',\'processing\') AND id < (SELECT MAX(id) FROM queue WHERE user_id = ?)',
    [user.id]
  ) || {}).c || 0;

  // Notify user of queue position via socket
  io.to(`user:${req.user}`).emit('queue_update', { position });

  res.json({ ok: true, queuePosition: position });
});

// ── Mail ──────────────────────────────────────────────────────────────────────

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

app.get('/api/mail/unread', async (req, res) => {
  await getDb();
  const user = get('SELECT id FROM users WHERE username = ?', [req.user]);
  if (!user) return res.json({ count: 0 });
  const row = get('SELECT COUNT(*) as c FROM mail WHERE to_user_id = ? AND read = 0', [user.id]);
  res.json({ count: row?.c || 0 });
});

app.post('/api/mail/send', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !body?.trim()) return res.status(400).json({ error: 'to and body required' });

  await getDb();
  const sender = get('SELECT id FROM users WHERE username = ?', [req.user]);
  const recipient = get('SELECT id, username FROM users WHERE username = ?', [to.toLowerCase()]);
  if (!recipient) return res.status(404).json({ error: 'recipient not found' });

  const mailId = insert(
    'INSERT INTO mail (from_user_id, to_user_id, subject, body) VALUES (?,?,?,?)',
    [sender.id, recipient.id, (subject || '').trim(), body.trim()]
  );

  // Notify recipient via socket
  io.to(`user:${recipient.username}`).emit('new_mail', {
    id: mailId,
    from_username: req.user,
    subject: (subject || '').trim(),
    body: body.trim(),
    created_at: Math.floor(Date.now() / 1000),
  });

  res.json({ ok: true });
});

app.patch('/api/mail/:id/read', async (req, res) => {
  await getDb();
  const user = get('SELECT id FROM users WHERE username = ?', [req.user]);
  run('UPDATE mail SET read = 1 WHERE id = ? AND to_user_id = ?', [req.params.id, user.id]);
  res.json({ ok: true });
});

// Claw broadcasts a message to all users (or specific user)
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
      [null, r.id, (subject || 'A note from Claw').trim(), body.trim()]
    );
    io.to(`user:${r.username}`).emit('new_mail', {
      from_username: 'claw',
      from_claw: true,
      subject: (subject || 'A note from Claw').trim(),
      body: body.trim(),
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  res.json({ ok: true, sent: recipients.length });
});

app.post('/api/onboard', async (req, res) => {
  const { buildingName } = req.body;
  if (!buildingName?.trim()) return res.status(400).json({ error: 'buildingName required' });

  await getDb();
  const user = get('SELECT id FROM users WHERE username = ?', [req.user]);
  if (!user) return res.status(404).json({ error: 'user not found' });

  run('UPDATE buildings SET name = ? WHERE user_id = ?', [buildingName.trim(), user.id]);
  run('UPDATE users SET onboarded = 1 WHERE id = ?', [user.id]);

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
