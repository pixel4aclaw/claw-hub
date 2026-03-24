'use strict';

/**
 * agent-child.js — Isolated subprocess for Claude SDK calls.
 *
 * The Claude Agent SDK spawns the claude binary in the same process group.
 * When the binary exits it sends a signal (possibly SIGKILL) to the group,
 * killing the parent server. This script runs in its own process group
 * (via fork + detached) so those signals only affect this subprocess.
 *
 * Communication: receives task via IPC message, sends result back via IPC.
 */

// Ignore SIGINT — the claude binary sends it to the process group on exit.
// We communicate results via IPC; the parent handles lifecycle.
process.on('SIGINT', () => {
  console.log('[agent-child] SIGINT ignored');
});

const { query } = require('@anthropic-ai/claude-agent-sdk');

process.on('message', async (task) => {
  const { prompt, options } = task;

  let result = '';
  let newSessionId = null;
  let rateLimitInfo = null;

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
      }
      if ('result' in message) {
        result = message.result || '';
      }
      if (message.type === 'rate_limit_event') {
        const info = message.rate_limit_info || {};
        console.log(`[agent-child] rate_limit_event: ${JSON.stringify(info)}`);
        if (info.status && info.status !== 'allowed') {
          rateLimitInfo = info;
        }
      }
    }

    process.send({ ok: true, result, newSessionId, rateLimitInfo });
  } catch (err) {
    process.send({
      ok: false,
      error: err.message,
      rateLimitedUntil: err.rateLimitedUntil || null,
    });
  }

  // Give IPC time to flush, then exit
  setTimeout(() => process.exit(0), 500);
});
