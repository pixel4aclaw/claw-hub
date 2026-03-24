'use strict';

/**
 * Claw Hub — Queue Worker
 *
 * Polls the queue table for pending items, runs the full Claude agent
 * (with tools: bash, file read/write, web search), saves responses,
 * and emits them to the user via Socket.io.
 *
 * Each user gets a persistent agent session — conversation context,
 * tool state, and memory carry across messages automatically.
 */

const path = require('path');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { get, all, insert, run } = require('./db');

const POLL_INTERVAL_MS = 2000;

const SYSTEM_PROMPT = `You are Claw, the AI at the heart of Claw Hub — a collaborative app where developers experiment with building AI-powered projects. You live in the codebase you're talking about.

You have full access to the server and can actually implement features, fix bugs, write code, run commands, and make changes. When a user asks you to build something, you build it. When they ask a question, answer it directly and technically.

Be sharp and brief. Match the energy of a senior dev pair-programming with a peer — direct, no fluff, show your work when it matters.`;

async function callAgent(username, userId, userMessage) {
  // Look up any existing session for this user
  const user = get('SELECT session_id FROM users WHERE id = ?', [userId]);
  const existingSessionId = user?.session_id;

  const options = {
    cwd: __dirname,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 30,
    systemPrompt: `${SYSTEM_PROMPT}\n\nYou're speaking with ${username}.`,
  };

  if (existingSessionId) {
    options.resume = existingSessionId;
  }

  let result = '';
  let newSessionId = null;

  for await (const message of query({ prompt: userMessage, options })) {
    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
    }
    if ('result' in message) {
      result = message.result || '';
    }
  }

  // Persist the session ID so the next message resumes with full context
  if (newSessionId && newSessionId !== existingSessionId) {
    run('UPDATE users SET session_id = ? WHERE id = ?', [newSessionId, userId]);
  }

  return result;
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
  if (!item) return;

  // Mark as processing (prevent double-pick)
  run(
    `UPDATE queue SET status = 'processing', started_at = strftime('%s','now') WHERE id = ? AND status = 'pending'`,
    [item.id]
  );

  // Verify we actually got the lock
  const locked = get('SELECT id FROM queue WHERE id = ? AND status = ?', [item.id, 'processing']);
  if (!locked) return;

  console.log(`[queue] processing item ${item.id} for ${item.username}`);

  try {
    // Fetch the specific user message for this queue item
    const msg = get('SELECT content FROM messages WHERE id = ?', [item.message_id]);
    if (!msg) throw new Error(`message ${item.message_id} not found`);

    // Emit queue position = 0 (we're thinking now)
    io.to(`user:${item.username}`).emit('queue_update', { position: 0 });

    const reply = await callAgent(item.username, item.user_id, msg.content);
    if (!reply) throw new Error('Empty response from agent');

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

    // Update queue status indicator
    const remaining = (get(
      `SELECT COUNT(*) as c FROM queue WHERE user_id = ? AND status = 'pending'`,
      [item.user_id]
    ) || {}).c || 0;
    io.to(`user:${item.username}`).emit('queue_update', {
      position: remaining > 0 ? 1 : null,
    });

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
  if (process.env.NODE_ENV === 'test') return;

  console.log(`[queue] worker started, polling every ${POLL_INTERVAL_MS}ms`);

  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try { await processNext(io); } finally { busy = false; }
  }

  setImmediate(tick);
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { startWorker };
