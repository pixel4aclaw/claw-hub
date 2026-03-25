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

// Track accumulated text from assistant messages so we can salvage partial
// results when SIGINT arrives mid-stream.
let partialResult = '';
let newSessionId = null;
let rateLimitInfo = null;
let resultSent = false;

function sendResult(ok, result, error) {
  if (resultSent) return;
  resultSent = true;
  try {
    if (ok) {
      process.send({ ok: true, result, newSessionId, rateLimitInfo });
    } else {
      process.send({ ok: false, error, rateLimitedUntil: null });
    }
  } catch (_) { /* IPC broken — nothing we can do */ }
}

// When SIGINT arrives (from claude binary exiting), send whatever we have
// instead of dying silently.
process.on('SIGINT', () => {
  console.log('[agent-child] SIGINT received, sending partial result');
  sendResult(true, partialResult || '', null);
  setTimeout(() => process.exit(0), 300);
});

// Also handle SIGTERM gracefully
process.on('SIGTERM', () => {
  console.log('[agent-child] SIGTERM received, sending partial result');
  sendResult(true, partialResult || '', null);
  setTimeout(() => process.exit(0), 300);
});

const { query } = require('@anthropic-ai/claude-agent-sdk');

process.on('message', async (task) => {
  const { prompt, options } = task;

  partialResult = '';
  newSessionId = null;
  rateLimitInfo = null;
  resultSent = false;

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
      }
      if ('result' in message) {
        partialResult = message.result || '';
      }
      if (message.type === 'rate_limit_event') {
        const info = message.rate_limit_info || {};
        console.log(`[agent-child] rate_limit_event: ${JSON.stringify(info)}`);
        if (info.status && info.status !== 'allowed') {
          rateLimitInfo = info;
        }
      }

      // Accumulate text from assistant messages as partial result backup
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) {
            partialResult = block.text; // latest text block is the best candidate
          }
        }
      }

      // Stream chain-of-thought progress to parent (no extra tokens used)
      try {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              process.send({ progress: true, kind: 'tool', tool: block.name, input: (block.input?.command || block.input?.pattern || block.input?.file_path || block.input?.query || '').slice(0, 120) });
            } else if (block.type === 'text' && block.text) {
              process.send({ progress: true, kind: 'text', preview: block.text.slice(0, 120) });
            } else if (block.type === 'thinking' && block.thinking) {
              process.send({ progress: true, kind: 'thinking', preview: block.thinking.slice(0, 120) });
            }
          }
        } else if (message.type === 'tool_use_summary') {
          process.send({ progress: true, kind: 'summary', text: (message.summary || '').slice(0, 120) });
        } else if (message.type === 'tool_progress') {
          process.send({ progress: true, kind: 'tool_running', tool: message.tool_name, elapsed: message.elapsed_time_seconds });
        }
      } catch (_) { /* IPC send can fail if parent disconnected — ignore */ }
    }

    sendResult(true, partialResult, null);
  } catch (err) {
    sendResult(false, null, err.message);
  }

  // Give IPC time to flush, then exit
  setTimeout(() => process.exit(0), 500);
});
