/**
 * Claw Hub — E2E test suite
 * Run with: npm test
 *
 * Spins up the server on a random port with an in-memory DB,
 * runs all tests, then tears down. No external dependencies.
 */

'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Test DB: override DB_PATH so tests use a temp in-memory instance ──────────
process.env.NODE_ENV = 'test';
process.env.DB_PATH_OVERRIDE = ':memory:';

// ── Helpers ───────────────────────────────────────────────────────────────────
let baseUrl;
let serverInstance;

/**
 * Lightweight cookie jar — tracks Set-Cookie and sends Cookie header.
 */
class Jar {
  constructor() { this.cookies = {}; }
  store(res) {
    const h = res.headers.get('set-cookie');
    if (!h) return;
    for (const part of h.split(',')) {
      const [pair] = part.trim().split(';');
      const [k, ...rest] = pair.split('=');
      const v = rest.join('=');
      if (k) {
        const key = k.trim();
        if (v) this.cookies[key] = v.trim();
        else delete this.cookies[key]; // cleared cookie
      }
    }
  }
  header() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function req(method, path, body, jar) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar) headers['Cookie'] = jar.header();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (jar) jar.store(res);
  let json;
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, body: json };
}

async function login(username = 'testuser', password = process.env.SITE_PASSWORD) {
  const jar = new Jar();
  const r = await req('POST', '/api/login', { username, password }, jar);
  return { jar, body: r.body, status: r.status };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
before(async () => {
  // Patch db.js to use in-memory SQLite for tests
  const db = require('../db');
  await db.getDb(); // initialize with in-memory DB

  const { start } = require('../server');
  serverInstance = await start(0); // port 0 = OS assigns random free port
  const { port } = serverInstance.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  const { stop } = require('../server');
  await stop();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
describe('Auth', () => {
  test('GET /login redirects authenticated users', async () => {
    const { jar } = await login('authtest');
    const res = await fetch(`${baseUrl}/login`, {
      method: 'GET',
      headers: { Cookie: jar.header() },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
  });

  test('POST /api/login rejects wrong password', async () => {
    const r = await req('POST', '/api/login', { username: 'foo', password: 'wrong' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'wrong password');
  });

  test('POST /api/login rejects missing fields', async () => {
    const r = await req('POST', '/api/login', { username: 'foo' });
    assert.equal(r.status, 400);
  });

  test('POST /api/login creates new user and returns ok', async () => {
    const { status, body } = await login('brandnewuser');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.isNew, true);
    assert.equal(body.username, 'brandnewuser');
  });

  test('POST /api/login returns isNew=false for existing user', async () => {
    await login('repeatuser');
    const { body } = await login('repeatuser');
    assert.equal(body.isNew, false);
  });

  test('username is case-insensitive', async () => {
    await login('MixedCase');
    const { body } = await login('mixedcase');
    assert.equal(body.isNew, false);
  });

  test('GET /api/me returns user info when authenticated', async () => {
    const { jar } = await login('metest');
    const r = await req('GET', '/api/me', null, jar);
    assert.equal(r.status, 200);
    assert.equal(r.body.username, 'metest');
    assert.ok(r.body.id);
  });

  test('GET /api/me returns 302 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/me`, { redirect: 'manual' });
    assert.ok([302, 401].includes(res.status));
  });

  test('POST /api/logout clears session', async () => {
    const { jar } = await login('logouttest');
    await req('POST', '/api/logout', null, jar);
    const r = await req('GET', '/api/me', null, jar);
    assert.ok([302, 401].includes(r.status));
  });
});

// ── Chat & Messages ───────────────────────────────────────────────────────────
describe('Chat', () => {
  test('GET /api/messages returns empty array for new user', async () => {
    const { jar } = await login('chattest1');
    const r = await req('GET', '/api/messages', null, jar);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  test('POST /api/chat queues a message and returns position', async () => {
    const { jar } = await login('chattest2');
    const r = await req('POST', '/api/chat', { message: 'hello claw' }, jar);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(typeof r.body.queuePosition, 'number');
  });

  test('POST /api/chat rejects empty message', async () => {
    const { jar } = await login('chattest3');
    const r = await req('POST', '/api/chat', { message: '   ' }, jar);
    assert.equal(r.status, 400);
  });

  test('GET /api/messages returns sent messages', async () => {
    const { jar } = await login('chattest4');
    await req('POST', '/api/chat', { message: 'test message' }, jar);
    const r = await req('GET', '/api/messages', null, jar);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.ok(r.body.length >= 1);
    assert.equal(r.body[0].role, 'user');
    assert.equal(r.body[0].content, 'test message');
  });

  test('messages are isolated per user', async () => {
    const { jar: jar1 } = await login('isolate1');
    const { jar: jar2 } = await login('isolate2');
    await req('POST', '/api/chat', { message: 'only for user1' }, jar1);
    const r = await req('GET', '/api/messages', null, jar2);
    assert.equal(r.body.length, 0);
  });
});

// ── Mail ──────────────────────────────────────────────────────────────────────
describe('Mail', () => {
  test('POST /api/mail/broadcast sends to all users', async () => {
    const { jar } = await login('broadcaster');
    const r = await req('POST', '/api/mail/broadcast', { body: 'Hello everyone!' }, jar);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.sent >= 1);
  });

  test('POST /api/mail/broadcast rejects missing body', async () => {
    const { jar } = await login('broadcaster2');
    const r = await req('POST', '/api/mail/broadcast', { subject: 'no body' }, jar);
    assert.equal(r.status, 400);
  });

  test('POST /api/mail/broadcast can target a specific user', async () => {
    const { jar: jarA } = await login('mailtarget_sender');
    const { jar: jarB } = await login('mailtarget_recv');
    const r = await req('POST', '/api/mail/broadcast',
      { body: 'just for you', to: 'mailtarget_recv' }, jarA);
    assert.equal(r.body.sent, 1);
    const inbox = await req('GET', '/api/mail', null, jarB);
    assert.ok(inbox.body.some(m => m.body === 'just for you'));
  });

  test('POST /api/mail/relay delivers message between users', async () => {
    const { jar: jarSender } = await login('relay_sender');
    const { jar: jarRecv }   = await login('relay_recv');
    const r = await req('POST', '/api/mail/relay',
      { from: 'relay_sender', to: 'relay_recv', body: 'relayed message' }, jarSender);
    assert.equal(r.status, 200);
    const inbox = await req('GET', '/api/mail', null, jarRecv);
    assert.ok(inbox.body.some(m => m.body === 'relayed message'));
  });

  test('POST /api/mail/relay rejects unknown recipient', async () => {
    const { jar } = await login('relay_bad_sender');
    const r = await req('POST', '/api/mail/relay',
      { from: 'relay_bad_sender', to: 'doesnotexist_xyz', body: 'hi' }, jar);
    assert.equal(r.status, 404);
  });

  test('GET /api/mail returns inbox for current user', async () => {
    const { jar } = await login('inbox_user');
    await req('POST', '/api/mail/broadcast', { body: 'test inbox', to: 'inbox_user' }, jar);
    const r = await req('GET', '/api/mail', null, jar);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.ok(r.body.length >= 1);
  });
});

// ── Repos ─────────────────────────────────────────────────────────────────────
describe('Repos', () => {
  test('GET /api/repos returns array', async () => {
    const { jar } = await login('repouser1');
    const r = await req('GET', '/api/repos', null, jar);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  test('POST /api/repos creates a repo', async () => {
    const { jar } = await login('repouser2');
    const r = await req('POST', '/api/repos', {
      name: 'my-project',
      description: 'cool thing',
      repo_url: 'https://github.com/test/test',
      site_url: '',
    }, jar);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.repo.name, 'my-project');
    assert.equal(r.body.repo.username, 'repouser2');
  });

  test('POST /api/repos rejects missing name', async () => {
    const { jar } = await login('repouser3');
    const r = await req('POST', '/api/repos', { description: 'no name' }, jar);
    assert.equal(r.status, 400);
  });

  test('POST /api/repos — new repo shows in GET /api/repos', async () => {
    const { jar } = await login('repouser4');
    await req('POST', '/api/repos', { name: 'visible-repo' }, jar);
    const list = await req('GET', '/api/repos', null, jar);
    assert.ok(list.body.some(r => r.name === 'visible-repo'));
  });

  test('DELETE /api/repos/:id removes own repo', async () => {
    const { jar } = await login('repouser5');
    const created = await req('POST', '/api/repos', { name: 'to-delete' }, jar);
    const id = created.body.repo.id;
    const del = await req('DELETE', `/api/repos/${id}`, null, jar);
    assert.equal(del.status, 200);
    const list = await req('GET', '/api/repos', null, jar);
    assert.ok(!list.body.some(r => r.id === id));
  });

  test("DELETE /api/repos/:id cannot delete another user's repo", async () => {
    const { jar: jar1 } = await login('repoowner');
    const { jar: jar2 } = await login('repothief');
    const created = await req('POST', '/api/repos', { name: 'not-yours' }, jar1);
    const id = created.body.repo.id;
    const del = await req('DELETE', `/api/repos/${id}`, null, jar2);
    assert.equal(del.status, 403);
  });
});

// ── Blog ──────────────────────────────────────────────────────────────────────
describe('Blog', () => {
  test('GET /api/blog returns array', async () => {
    const { jar } = await login('blogger1');
    const r = await req('GET', '/api/blog', null, jar);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  test('POST /api/blog creates a post', async () => {
    const { jar } = await login('blogger2');
    const r = await req('POST', '/api/blog', {
      title: 'Test Post',
      body: 'This is a test.',
      topic: 'testing',
    }, jar);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.post.title, 'Test Post');
  });

  test('POST /api/blog rejects missing title', async () => {
    const { jar } = await login('blogger3');
    const r = await req('POST', '/api/blog', { body: 'no title' }, jar);
    assert.equal(r.status, 400);
  });

  test('POST /api/blog — post visible in GET /api/blog', async () => {
    const { jar } = await login('blogger4');
    await req('POST', '/api/blog', { title: 'Visible Post', body: 'content here' }, jar);
    const list = await req('GET', '/api/blog', null, jar);
    assert.ok(list.body.some(p => p.title === 'Visible Post'));
  });

  test('GET /api/blog supports pagination', async () => {
    const { jar } = await login('blogger5');
    const r = await req('GET', '/api/blog?limit=2&offset=0', null, jar);
    assert.equal(r.status, 200);
    assert.ok(r.body.length <= 2);
  });
});

// ── Status ────────────────────────────────────────────────────────────────────
describe('Status', () => {
  test('GET /api/status returns expected shape', async () => {
    const { jar } = await login('statususer');
    const r = await req('GET', '/api/status', null, jar);
    assert.equal(r.status, 200);
    assert.ok(r.body.server);
    assert.ok(r.body.system);
    assert.ok(r.body.stats);
    assert.equal(typeof r.body.server.uptime, 'number');
    assert.equal(typeof r.body.system.memory.pct, 'number');
    assert.equal(typeof r.body.stats.users, 'number');
  });

  test('GET /api/health returns ok', async () => {
    const { jar } = await login('healthuser');
    const r = await req('GET', '/api/health', null, jar);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
describe('Rate limiting', () => {
  test('rateLimit() middleware enforces max requests per window', () => {
    // Unit-test the rateLimit factory directly without a live server
    const { rateLimit: rateLimitFn } = require('../server');
    const middleware = rateLimitFn({ windowMs: 60000, max: 3 });

    let blocked = false;
    const fakeReq = { ip: '1.2.3.4', path: '/test' };
    const fakeRes = { status: (code) => ({ json: () => { if (code === 429) blocked = true; } }) };
    const next = () => {};

    middleware(fakeReq, fakeRes, next); // 1
    middleware(fakeReq, fakeRes, next); // 2
    middleware(fakeReq, fakeRes, next); // 3
    middleware(fakeReq, fakeRes, next); // 4 — over limit

    assert.ok(blocked, 'Expected rate limiter to block after max requests');
  });
});

// ── Input validation ──────────────────────────────────────────────────────────
describe('Input validation', () => {
  test('Username is trimmed and lowercased', async () => {
    const { body } = await login('  MyUser  ');
    assert.equal(body.username, 'myuser');
  });

  test('Chat message is trimmed', async () => {
    const { jar } = await login('trimtest');
    const r = await req('POST', '/api/chat', { message: '  hello  ' }, jar);
    assert.equal(r.status, 200);
    const msgs = await req('GET', '/api/messages', null, jar);
    assert.equal(msgs.body[0].content, 'hello');
  });
});
