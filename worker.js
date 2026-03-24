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
const MAX_RETRIES = 2; // total attempts per queue item
const BACKOFF_MS = 3000; // pause between retries
const ALERT_THRESHOLD = 3; // consecutive errors before alerting admin

// Track consecutive errors globally (reset on any success)
let consecutiveErrors = 0;
let alertSent = false;

const SYSTEM_PROMPT = `You are Claw, the AI at the heart of Claw Hub — a collaborative app where ~40 developers experiment with building AI-powered projects. You live inside the codebase on a Pixel 4a running Termux.

You have full access to the server: Bash, file read/write, code editing, web search. When a user asks you to build something, you build it. When they ask a question, answer directly.

You're not a wrapper around a chat API — you're an agent that can do real work. Use your tools freely. Read files, run commands, search the web, write code. Show your work when it matters.

Be warm but sharp. Talk like a senior dev pair-programming with a peer — direct, no fluff, technically precise. Use markdown for code blocks and formatting. Keep responses concise unless the topic demands depth.

If a user sends multiple messages at once, address them all in a single response — don't repeat yourself across messages.`;

async function callAgent(username, userId, userMessage, forceNewSession) {
  const user = get('SELECT session_id FROM users WHERE id = ?', [userId]);
  const existingSessionId = forceNewSession ? null : user?.session_id;

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
    // Debug: log unexpected message shapes
    if (message.type && !['system', 'assistant', 'user', 'tool', 'result'].includes(message.type)) {
      console.log(`[queue] sdk msg type=${message.type} subtype=${message.subtype} keys=${Object.keys(message).join(',')}`);
    }
    if (message.type === 'result') {
      console.log(`[queue] sdk result subtype=${message.subtype} result_len=${(message.result||'').length}`);
    }
  }
  console.log(`[queue] callAgent done, result_len=${result.length}`);

  if (newSessionId && newSessionId !== existingSessionId) {
    run('UPDATE users SET session_id = ? WHERE id = ?', [newSessionId, userId]);
  }

  return result;
}

function friendlyError(err) {
  const msg = err.message || '';
  if (msg.includes('timed out'))
    return 'That took too long and I had to stop \u2014 this can happen with complex requests. Your message is saved, so just send **try again** and I\'ll pick up where I left off.';
  if (msg.includes('Empty response'))
    return 'I processed your message but came back empty-handed \u2014 probably a hiccup. Send **try again** and I\'ll give it another shot.';
  if (msg.includes('400') || msg.includes('invalid_request'))
    return 'Something went wrong with my connection to the AI service. This usually resolves on its own \u2014 try sending your message again in a minute.';
  if (msg.includes('429') || msg.includes('rate'))
    return 'I\'m being rate-limited right now \u2014 too many requests. Give it a couple minutes and try again.';
  return `Something went wrong on my end (${msg}). Your message is saved \u2014 send **try again** to retry.`;
}

async function notifyAdmin(io, message) {
  // Find admin user (first user, or user with username matching known admin)
  const admin = get("SELECT id, username FROM users WHERE id = 1");
  if (!admin) return;
  console.error(`[queue] ALERT: ${message}`);
  io.to(`user:${admin.username}`).emit('chat_response', {
    content: `⚠️ **Worker alert:** ${message}`,
    created_at: Date.now(),
    error: true,
  });
}

async function processNext(io) {
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

  const msg = get('SELECT content FROM messages WHERE id = ?', [item.message_id]);
  if (!msg) {
    run(`UPDATE queue SET status = 'error', completed_at = strftime('%s','now') WHERE id = ?`, [item.id]);
    return;
  }

  io.to(`user:${item.username}`).emit('queue_update', { position: 0 });

  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // On retry after failure, try a fresh session (session might be corrupted)
      const forceNewSession = attempt > 1;
      if (forceNewSession) {
        console.log(`[queue] item ${item.id} retry ${attempt}/${MAX_RETRIES} (fresh session)`);
      }

      const reply = await Promise.race([
        callAgent(item.username, item.user_id, msg.content, forceNewSession),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Agent timed out after 5 minutes')), AGENT_TIMEOUT_MS)
        ),
      ]);
      if (!reply) throw new Error('Empty response from agent');

      // Success
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

      console.log(`[queue] done item ${item.id} for ${item.username}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);

      // Reset error tracking on success
      consecutiveErrors = 0;
      alertSent = false;
      return;
    } catch (err) {
      lastErr = err;
      console.error(`[queue] attempt ${attempt}/${MAX_RETRIES} failed for item ${item.id}: ${err.message}`);

      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, BACKOFF_MS));
      }
    }
  }

  // All retries exhausted
  console.error(`[queue] giving up on item ${item.id}: ${lastErr.message}`);
  run(
    `UPDATE queue SET status = 'error', completed_at = strftime('%s','now') WHERE id = ?`,
    [item.id]
  );

  // Send user-friendly error
  const userMsg = friendlyError(lastErr);
  insert(
    'INSERT INTO messages (user_id, role, content) VALUES (?,?,?)',
    [item.user_id, 'assistant', userMsg]
  );
  io.to(`user:${item.username}`).emit('chat_response', {
    content: userMsg,
    created_at: Date.now(),
    error: true,
  });

  // Track consecutive failures and alert admin
  consecutiveErrors++;
  if (consecutiveErrors >= ALERT_THRESHOLD && !alertSent) {
    alertSent = true;
    notifyAdmin(io, `${consecutiveErrors} consecutive queue failures. Last error: ${lastErr.message}. Worker may need attention.`);
  }
}

function reclaimStale(io) {
  // On startup: reclaim ALL processing items (process just started, nothing can be legitimately in-flight)
  // During runtime: reclaim items processing longer than STALE_THRESHOLD_S (timeout didn't fire for some reason)
  const stale = all(
    `SELECT q.id, q.user_id, u.username FROM queue q JOIN users u ON q.user_id = u.id
     WHERE q.status = 'processing'`,
    []
  );
  for (const s of stale) {
    run("UPDATE queue SET status = 'pending', started_at = NULL WHERE id = ?", [s.id]);
    console.log(`[queue] reclaimed stale item ${s.id} for ${s.username}`);
    // Notify user so they know it's back in queue
    if (io) io.to(`user:${s.username}`).emit('queue_update', { position: 0 });
  }
  if (stale.length) console.log(`[queue] reclaimed ${stale.length} stale item(s) on startup`);
}

function reclaimOverdue(io) {
  // Periodic check: reclaim items stuck in processing longer than the timeout
  const stale = all(
    `SELECT q.id, q.user_id, u.username FROM queue q JOIN users u ON q.user_id = u.id
     WHERE q.status = 'processing'
       AND q.started_at IS NOT NULL
       AND (CAST(strftime('%s','now') AS INTEGER) - CAST(q.started_at AS INTEGER)) > ?`,
    [STALE_THRESHOLD_S]
  );
  for (const s of stale) {
    run("UPDATE queue SET status = 'pending', started_at = NULL WHERE id = ?", [s.id]);
    console.log(`[queue] reclaimed overdue item ${s.id} for ${s.username}`);
    if (io) io.to(`user:${s.username}`).emit('queue_update', { position: 0 });
  }
}

function startWorker(io) {
  if (process.env.NODE_ENV === 'test') return;

  // On startup: unconditionally reclaim ALL processing items — nothing is legitimately in-flight yet
  reclaimStale(io);

  console.log(`[queue] worker started, polling every ${POLL_INTERVAL_MS}ms`);

  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try { await processNext(io); } finally { busy = false; }
  }

  setImmediate(tick);
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  // Periodic overdue check every 60s (catches anything the timeout missed)
  const overdueTimer = setInterval(() => reclaimOverdue(io), 60000);
  timer.unref();
  overdueTimer.unref();
  return timer;
}

module.exports = { startWorker };
