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
 * Pending messages for the same user are batched into a single agent call.
 */

const path = require('path');
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { get, all, insert, run } = require('./db');

const POLL_INTERVAL_MS = 2000;

const SYSTEM_PROMPT = `You are Claw, the AI at the heart of Claw Hub — a collaborative app where ~40 developers experiment with building AI-powered projects. You live inside the codebase on a Pixel 4a running Termux.

You have full access to the server: Bash, file read/write, code editing, web search. When a user asks you to build something, you build it. When they ask a question, answer directly.

You're not a wrapper around a chat API — you're an agent that can do real work. Use your tools freely. Read files, run commands, search the web, write code. Show your work when it matters.

Be warm but sharp. Talk like a senior dev pair-programming with a peer — direct, no fluff, technically precise. Use markdown for code blocks and formatting. Keep responses concise unless the topic demands depth.

If a user sends multiple messages at once, address them all in a single response — don't repeat yourself across messages.`;

async function callAgent(username, userId, userMessage) {
  // Look up any existing session for this user
  const user = get('SELECT session_id FROM users WHERE id = ?', [userId]);
  const existingSessionId = user?.session_id;

  const options = {
    model: 'sonnet',
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
  // Grab ALL pending items for the oldest pending user (batch same-user messages)
  const first = get(`
    SELECT q.user_id, u.username
    FROM queue q
    JOIN users u ON q.user_id = u.id
    WHERE q.status = 'pending'
    ORDER BY q.id ASC
    LIMIT 1
  `);
  if (!first) return;

  const items = all(`
    SELECT q.id, q.message_id
    FROM queue q
    WHERE q.user_id = ? AND q.status = 'pending'
    ORDER BY q.id ASC
  `, [first.user_id]);
  if (!items.length) return;

  // Lock all items
  const ids = items.map(i => i.id);
  for (const id of ids) {
    run(
      `UPDATE queue SET status = 'processing', started_at = strftime('%s','now') WHERE id = ? AND status = 'pending'`,
      [id]
    );
  }

  console.log(`[queue] processing ${items.length} item(s) [${ids.join(',')}] for ${first.username}`);

  try {
    // Fetch all user messages for this batch
    const messages = items.map(item => {
      const msg = get('SELECT content FROM messages WHERE id = ?', [item.message_id]);
      if (!msg) throw new Error(`message ${item.message_id} not found`);
      return msg.content;
    });

    // Emit queue position = 0 (thinking)
    io.to(`user:${first.username}`).emit('queue_update', { position: 0 });

    // Combine messages into a single prompt
    const prompt = messages.length === 1
      ? messages[0]
      : messages.map((m, i) => `[Message ${i + 1}] ${m}`).join('\n\n');

    const reply = await callAgent(first.username, first.user_id, prompt);
    if (!reply) throw new Error('Empty response from agent');

    // Save single assistant message
    insert(
      'INSERT INTO messages (user_id, role, content) VALUES (?,?,?)',
      [first.user_id, 'assistant', reply]
    );

    // Mark all items done
    for (const id of ids) {
      run(
        `UPDATE queue SET status = 'done', completed_at = strftime('%s','now') WHERE id = ?`,
        [id]
      );
    }

    // Push to user
    io.to(`user:${first.username}`).emit('chat_response', {
      content: reply,
      created_at: Date.now(),
    });

    // Update queue status
    const remaining = (get(
      `SELECT COUNT(*) as c FROM queue WHERE user_id = ? AND status = 'pending'`,
      [first.user_id]
    ) || {}).c || 0;
    io.to(`user:${first.username}`).emit('queue_update', {
      position: remaining > 0 ? 1 : null,
    });

    console.log(`[queue] done ${items.length} item(s) [${ids.join(',')}] for ${first.username}`);
  } catch (err) {
    console.error(`[queue] error on items [${ids.join(',')}]:`, err.message);
    for (const id of ids) {
      run(
        `UPDATE queue SET status = 'error', completed_at = strftime('%s','now') WHERE id = ?`,
        [id]
      );
    }
    io.to(`user:${first.username}`).emit('chat_response', {
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
