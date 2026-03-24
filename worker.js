'use strict';

/**
 * Claw Hub — Queue Worker
 *
 * Polls the queue table for pending items, calls the Claude API,
 * saves the response, and emits it to the user via Socket.io.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { get, all, insert, run } = require('./db');

const MODEL = 'claude-haiku-4-5-20251001';
const POLL_INTERVAL_MS = 2000;
const MAX_HISTORY = 40; // messages to include in context

const SYSTEM_PROMPT = `You are Claw, an AI assistant embedded in Claw Hub — a collaborative app where developers experiment with building AI-powered projects. You help users write code, build features, answer questions, and explore ideas together.

Be direct and technically sharp. Keep responses concise unless depth is genuinely needed. You can reference the hub context (repos, other users, blog posts) when relevant. When a user asks you to build something or add a feature, you actually do it — you have access to the server and can make changes.`;

function getToken() {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    return creds.oauthAccessToken || creds.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

async function callClaude(messages) {
  const token = getToken();
  if (!token) throw new Error('No API token available');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function processNext(io) {
  // Grab the oldest pending item and lock it
  const item = get(`
    SELECT q.id, q.user_id, q.message_id, u.username
    FROM queue q
    JOIN users u ON q.user_id = u.id
    WHERE q.status = 'pending'
    ORDER BY q.id ASC
    LIMIT 1
  `);
  if (!item) return; // nothing to do

  // Mark as processing (prevent double-pick)
  run(
    `UPDATE queue SET status = 'processing', started_at = strftime('%s','now') WHERE id = ? AND status = 'pending'`,
    [item.id]
  );

  // Verify we actually got the lock (another process could have taken it)
  const locked = get('SELECT id FROM queue WHERE id = ? AND status = ?', [item.id, 'processing']);
  if (!locked) return;

  console.log(`[queue] processing item ${item.id} for ${item.username}`);

  try {
    // Fetch message history for this user (capped to last MAX_HISTORY)
    const history = all(
      `SELECT role, content FROM messages
       WHERE user_id = ?
       ORDER BY created_at ASC`,
      [item.user_id]
    );

    // Convert to Claude message format (user/assistant only — no system)
    // Collapse consecutive same-role messages (can happen when many messages
    // are sent before any responses arrive, producing non-alternating history)
    const apiMessages = [];
    for (const msg of history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_HISTORY)) {
      const last = apiMessages[apiMessages.length - 1];
      if (last && last.role === msg.role) {
        last.content += '\n\n' + msg.content;
      } else {
        apiMessages.push({ role: msg.role, content: msg.content });
      }
    }

    // Claude API requires conversation to end with a user turn.
    // If trailing assistant messages exist (from concurrent processing),
    // drop them so the API sees a valid alternating sequence.
    while (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'assistant') {
      apiMessages.pop();
    }
    if (apiMessages.length === 0) throw new Error('No user messages in history');

    // Emit queue position = 0 (we're thinking now)
    io.to(`user:${item.username}`).emit('queue_update', { position: 0 });

    const reply = await callClaude(apiMessages);
    if (!reply) throw new Error('Empty response from Claude');

    // Save assistant message
    insert(
      'INSERT INTO messages (user_id, role, content) VALUES (?,?,?)',
      [item.user_id, 'assistant', reply]
    );

    // Mark done
    run(
      `UPDATE queue SET status = 'done', completed_at = strftime('%s','now') WHERE id = ?`,
      [item.id]
    );

    // Push to user
    io.to(`user:${item.username}`).emit('chat_response', {
      content: reply,
      created_at: Date.now(),
    });

    // Check if they have more pending items and update their position
    const remaining = (get(
      `SELECT COUNT(*) as c FROM queue WHERE user_id = ? AND status = 'pending'`,
      [item.user_id]
    ) || {}).c || 0;
    if (remaining > 0) {
      io.to(`user:${item.username}`).emit('queue_update', { position: 1 });
    } else {
      io.to(`user:${item.username}`).emit('queue_update', { position: null });
    }

    console.log(`[queue] done item ${item.id} for ${item.username}`);
  } catch (err) {
    console.error(`[queue] error on item ${item.id}:`, err.message);
    run(
      `UPDATE queue SET status = 'error', completed_at = strftime('%s','now') WHERE id = ?`,
      [item.id]
    );
    io.to(`user:${item.username}`).emit('chat_response', {
      content: `Sorry, I hit an error: ${err.message}`,
      created_at: Date.now(),
      error: true,
    });
  }
}

function startWorker(io) {
  if (process.env.NODE_ENV === 'test') return; // don't run in tests

  console.log(`[queue] worker started, polling every ${POLL_INTERVAL_MS}ms`);

  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try { await processNext(io); } finally { busy = false; }
  }

  setImmediate(tick);
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref(); // don't block process exit
  return timer;
}

module.exports = { startWorker };
