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
 *
 * Recent DB history is injected into each prompt so the agent always
 * has conversation context, even from before the SDK migration.
 */

const path = require('path');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { get, all, insert, run } = require('./db');

const POLL_INTERVAL_MS = 2000;
const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD_S = 300; // 5 minutes in seconds

const SYSTEM_PROMPT = `You are Claw, the AI at the heart of Claw Hub — a collaborative app where ~40 developers experiment with building AI-powered projects. You live inside the codebase on a Pixel 4a running Termux.

You have full access to the server: Bash, file read/write, code editing, web search. When a user asks you to build something, you build it. When they ask a question, answer directly.

You're not a wrapper around a chat API — you're an agent that can do real work. Use your tools freely. Read files, run commands, search the web, write code. Show your work when it matters.

Be warm but sharp. Talk like a senior dev pair-programming with a peer — direct, no fluff, technically precise. Use markdown for code blocks and formatting. Keep responses concise unless the topic demands depth.

If a user sends multiple messages at once, address them all in a single response — don't repeat yourself across messages.`;

async function callAgent(username, userId, userMessage) {
  // Look up any existing session for this user
  const user = get('SELECT session_id FROM users WHERE id = ?', [userId]);
  const existingSessionId = user?.session_id;

  // Fetch recent conversation history from DB so the agent has full context
  // (covers messages from before the SDK migration and across session boundaries)
  const history = all(
    `SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
    [userId]
  ).reverse();

  let contextBlock = '';
  if (history.length > 0) {
    const lines = history.map(m => `[${m.role}]: ${m.content}`).join('\n\n');
    contextBlock = `\n\nRecent conversation history with ${username}:\n---\n${lines}\n---`;
  }

  const options = {
    model: 'opus',
    cwd: __dirname,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 30,
    systemPrompt: `${SYSTEM_PROMPT}\n\nYou're speaking with ${username}.${contextBlock}`,
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
  // Grab the oldest pending item
  const item = get(`
    SELECT q.id, q.user_id, q.message_id, u.username
    FROM queue q
    JOIN users u ON q.user_id = u.id
    WHERE q.status = 'pending'
    ORDER BY q.id ASC
    LIMIT 1
  `);
  if (!item) return;

  // Lock it
  run(
    `UPDATE queue SET status = 'processing', started_at = strftime('%s','now') WHERE id = ? AND status = 'pending'`,
    [item.id]
  );
  const locked = get('SELECT id FROM queue WHERE id = ? AND status = ?', [item.id, 'processing']);
  if (!locked) return;

  console.log(`[queue] processing item ${item.id} for ${item.username}`);

  try {
    const msg = get('SELECT content FROM messages WHERE id = ?', [item.message_id]);
    if (!msg) throw new Error(`message ${item.message_id} not found`);

    io.to(`user:${item.username}`).emit('queue_update', { position: 0 });

    const reply = await Promise.race([
      callAgent(item.username, item.user_id, msg.content),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Agent timed out after 5 minutes')), AGENT_TIMEOUT_MS)
      ),
    ]);
    if (!reply) throw new Error('Empty response from agent');

    insert(
      'INSERT INTO messages (user_id, role, content) VALUES (?,?,?)',
      [item.user_id, 'assistant', reply]
    );

    run(
      `UPDATE queue SET status = 'done', completed_at = strftime('%s','now') WHERE id = ?`,
      [item.id]
    );

    io.to(`user:${item.username}`).emit('chat_response', {
      content: reply,
      created_at: Date.now(),
    });

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

  // Reclaim items stuck in 'processing' from a previous crash/restart
  const stale = all(
    `SELECT q.id, u.username FROM queue q JOIN users u ON q.user_id = u.id
     WHERE q.status = 'processing' AND (strftime('%s','now') - q.started_at) > ?`,
    [STALE_THRESHOLD_S]
  );
  for (const s of stale) {
    run("UPDATE queue SET status = 'pending', started_at = NULL WHERE id = ?", [s.id]);
    console.log(`[queue] reclaimed stale item ${s.id} for ${s.username}`);
  }
  if (stale.length) console.log(`[queue] reclaimed ${stale.length} stale item(s)`);

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
