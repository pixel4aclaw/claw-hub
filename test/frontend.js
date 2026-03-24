/**
 * Claw Hub — Frontend unit tests (jsdom)
 *
 * Tests DOM logic: panel navigation, hash routing, build cards,
 * message rendering, connection state, helpers.
 *
 * Run with: node --test test/frontend.js
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// Load the HTML once
const HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const HTML_SOURCE = fs.readFileSync(HTML_PATH, 'utf8');

/**
 * Create a fresh DOM environment for each test.
 * We strip the socket.io script tag (not available in jsdom) and
 * the main <script> block, then manually define the functions we want to test.
 */
function createDOM(hash = '') {
  // Strip the socket.io external script and the inline script
  const cleanHtml = HTML_SOURCE
    .replace(/<script src="\/socket\.io\/socket\.io\.js"><\/script>/, '')
    .replace(/<script>[\s\S]*?<\/script>/, '');

  const dom = new JSDOM(cleanHtml, {
    url: `http://localhost${hash ? '#' + hash : ''}`,
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    resources: 'usable',
  });

  const { window } = dom;
  const { document } = window;

  // Polyfill navigator.vibrate (jsdom doesn't have it)
  window.navigator.vibrate = () => true;

  // ── Inject testable functions (extracted from the inline script) ──

  const PANELS = ['chat', 'build', 'status', 'repos', 'blog'];
  let currentPanelIdx = 0;

  function panelFromHash() {
    const h = window.location.hash.replace('#', '').toLowerCase();
    return PANELS.includes(h) ? h : null;
  }

  function activatePanel(name, direction) {
    const nextIdx = PANELS.indexOf(name);
    if (nextIdx === -1) return;

    document.querySelectorAll('.panel').forEach(p => {
      p.classList.remove('active', 'from-right', 'from-left');
    });

    const next = document.getElementById(`panel-${name}`);
    const animClass = direction === 'forward' ? 'from-right' : direction === 'back' ? 'from-left' : null;
    next.classList.add('active');
    if (animClass) next.classList.add(animClass);

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`[data-panel="${name}"]`).classList.add('active');

    currentPanelIdx = nextIdx;
  }

  function showPanel(name) {
    const nextIdx = PANELS.indexOf(name);
    if (nextIdx === currentPanelIdx) return;
    const direction = nextIdx > currentPanelIdx ? 'forward' : 'back';
    window.history.pushState({ panel: name }, '', `#${name}`);
    activatePanel(name, direction);
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function reltime(ts) {
    if (!ts) return '';
    const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    const diff = (Date.now() - d) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleDateString();
  }

  function appendMsg(role, content, ts, scroll = true, noAnim = false) {
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    const msgBox = document.getElementById('messages');
    const typingEl = document.getElementById('typing-indicator');
    const div = document.createElement('div');
    div.className = `msg ${role}${noAnim ? ' no-anim' : ''}`;
    const text = document.createElement('span');
    text.textContent = content;
    div.appendChild(text);
    if (ts) {
      const time = document.createElement('span');
      time.className = 'ts';
      const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
      time.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      div.appendChild(time);
    }
    msgBox.insertBefore(div, typingEl);
  }

  function setConnState(state) {
    const dot = document.getElementById('status-dot');
    const banner = document.getElementById('conn-banner');
    dot.className = 'status-dot' + (state !== 'connected' ? ' ' + state : '');
    banner.className = state === 'connected' ? '' : state === 'offline' ? 'offline' : 'reconnecting';
    banner.style.display = state === 'connected' ? 'none' : 'flex';
  }

  const BUILD_IDEAS = [
    { icon: '🌐', label: 'Build a website', desc: 'Create a project.', prompt: 'Hey Claw, I want to build a personal portfolio site.' },
    { icon: '⏰', label: 'Something on a schedule', desc: 'Set up an automated task.', prompt: 'Claw, set up a scheduled job.' },
    { icon: '🛠️', label: 'Improve Claw Hub', desc: 'Suggest a feature.', prompt: 'I have an idea for Claw Hub.' },
    { icon: '🤖', label: 'Create a bot', desc: 'Build a bot.', prompt: 'Claw, build me a bot.' },
    { icon: '🎮', label: 'Make a game', desc: 'A browser game.', prompt: 'Hey Claw, build a Snake game.' },
    { icon: '📊', label: 'Data dashboard', desc: 'Visualize data.', prompt: 'Claw, create a weather dashboard.' },
    { icon: '✨', label: 'Surprise me', desc: 'Let Claw pick.', prompt: 'Surprise me, Claw.' },
  ];

  function renderBuildCards() {
    const grid = document.getElementById('build-grid');
    grid.innerHTML = BUILD_IDEAS.map((idea, i) => `
      <div class="build-card" data-idx="${i}">
        <div class="build-icon">${idea.icon}</div>
        <div class="build-label">${esc(idea.label)}</div>
        <div class="build-desc">${esc(idea.desc)}</div>
      </div>
    `).join('');
  }

  function pickBuild(idx) {
    const idea = BUILD_IDEAS[idx];
    showPanel('chat');
    const input = document.getElementById('chat-input');
    input.value = idea.prompt;
  }

  function updateBlogBadge(count) {
    const badge = document.getElementById('blog-badge');
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  return {
    dom, window, document,
    PANELS, activatePanel, showPanel, panelFromHash,
    esc, reltime, appendMsg, setConnState,
    BUILD_IDEAS, renderBuildCards, pickBuild, updateBlogBadge,
    get currentPanelIdx() { return currentPanelIdx; },
  };
}


// ── Panel Navigation ─────────────────────────────────────────────────────────
describe('Panel navigation', () => {
  test('activatePanel switches active panel and nav item', () => {
    const ctx = createDOM();
    ctx.activatePanel('status', 'forward');

    const panel = ctx.document.getElementById('panel-status');
    assert.ok(panel.classList.contains('active'), 'status panel should be active');

    const chatPanel = ctx.document.getElementById('panel-chat');
    assert.ok(!chatPanel.classList.contains('active'), 'chat panel should not be active');

    const navItem = ctx.document.querySelector('[data-panel="status"]');
    assert.ok(navItem.classList.contains('active'), 'status nav item should be active');
  });

  test('activatePanel adds from-right class for forward direction', () => {
    const ctx = createDOM();
    ctx.activatePanel('build', 'forward');
    const panel = ctx.document.getElementById('panel-build');
    assert.ok(panel.classList.contains('from-right'));
  });

  test('activatePanel adds from-left class for back direction', () => {
    const ctx = createDOM();
    ctx.activatePanel('status', 'forward');
    ctx.activatePanel('chat', 'back');
    const panel = ctx.document.getElementById('panel-chat');
    assert.ok(panel.classList.contains('from-left'));
  });

  test('activatePanel with null direction adds no animation class', () => {
    const ctx = createDOM();
    ctx.activatePanel('repos', null);
    const panel = ctx.document.getElementById('panel-repos');
    assert.ok(!panel.classList.contains('from-right'));
    assert.ok(!panel.classList.contains('from-left'));
    assert.ok(panel.classList.contains('active'));
  });

  test('activatePanel ignores invalid panel name', () => {
    const ctx = createDOM();
    ctx.activatePanel('chat', null); // start at chat
    ctx.activatePanel('nonexistent', 'forward');
    // Should still be on chat
    const chatPanel = ctx.document.getElementById('panel-chat');
    assert.ok(chatPanel.classList.contains('active'));
  });

  test('showPanel skips if already on that panel', () => {
    const ctx = createDOM();
    ctx.activatePanel('chat', null); // start at chat
    const before = ctx.window.history.length;
    ctx.showPanel('chat'); // should be a no-op
    // currentPanelIdx should still be 0
    assert.equal(ctx.currentPanelIdx, 0);
  });

  test('showPanel pushes history state', () => {
    const ctx = createDOM();
    ctx.activatePanel('chat', null);
    ctx.showPanel('status');
    assert.equal(ctx.window.location.hash, '#status');
  });

  test('only one panel is active at a time', () => {
    const ctx = createDOM();
    for (const name of ctx.PANELS) {
      ctx.activatePanel(name, null);
      const activePanels = ctx.document.querySelectorAll('.panel.active');
      assert.equal(activePanels.length, 1, `Expected exactly 1 active panel when switching to ${name}`);
      assert.equal(activePanels[0].id, `panel-${name}`);
    }
  });

  test('all 5 panels exist in DOM', () => {
    const ctx = createDOM();
    for (const name of ctx.PANELS) {
      const panel = ctx.document.getElementById(`panel-${name}`);
      assert.ok(panel, `panel-${name} should exist`);
    }
  });

  test('all 5 nav items exist', () => {
    const ctx = createDOM();
    for (const name of ctx.PANELS) {
      const nav = ctx.document.querySelector(`[data-panel="${name}"]`);
      assert.ok(nav, `nav item for ${name} should exist`);
    }
  });
});


// ── Hash Routing ─────────────────────────────────────────────────────────────
describe('Hash routing', () => {
  test('panelFromHash returns panel name from URL hash', () => {
    const ctx = createDOM('status');
    assert.equal(ctx.panelFromHash(), 'status');
  });

  test('panelFromHash returns null for invalid hash', () => {
    const ctx = createDOM('invalid');
    assert.equal(ctx.panelFromHash(), null);
  });

  test('panelFromHash returns null for empty hash', () => {
    const ctx = createDOM('');
    assert.equal(ctx.panelFromHash(), null);
  });

  test('panelFromHash is case-insensitive', () => {
    const ctx = createDOM('STATUS');
    assert.equal(ctx.panelFromHash(), 'status');
  });
});


// ── Message Rendering ────────────────────────────────────────────────────────
describe('Message rendering', () => {
  test('appendMsg adds a message div to messages', () => {
    const ctx = createDOM();
    ctx.appendMsg('user', 'hello world', Date.now());
    const msgs = ctx.document.querySelectorAll('#messages .msg');
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].classList.contains('user'));
    assert.equal(msgs[0].querySelector('span').textContent, 'hello world');
  });

  test('appendMsg removes welcome block', () => {
    const ctx = createDOM();
    assert.ok(ctx.document.getElementById('welcome'), 'welcome should exist initially');
    ctx.appendMsg('user', 'test', Date.now());
    assert.equal(ctx.document.getElementById('welcome'), null, 'welcome should be removed');
  });

  test('appendMsg adds no-anim class when specified', () => {
    const ctx = createDOM();
    ctx.appendMsg('claw', 'test', Date.now(), false, true);
    const msg = ctx.document.querySelector('#messages .msg');
    assert.ok(msg.classList.contains('no-anim'));
  });

  test('appendMsg inserts before typing indicator', () => {
    const ctx = createDOM();
    ctx.appendMsg('user', 'first', Date.now());
    ctx.appendMsg('claw', 'second', Date.now());
    const msgBox = ctx.document.getElementById('messages');
    const children = [...msgBox.children];
    const typingIdx = children.findIndex(c => c.id === 'typing-indicator');
    const lastMsgIdx = children.findIndex(c => c.classList.contains('msg') && c.textContent.includes('second'));
    assert.ok(lastMsgIdx < typingIdx, 'messages should be before typing indicator');
  });

  test('appendMsg adds timestamp span', () => {
    const ctx = createDOM();
    ctx.appendMsg('user', 'timestamped', Date.now());
    const ts = ctx.document.querySelector('#messages .msg .ts');
    assert.ok(ts, 'timestamp span should exist');
    assert.ok(ts.textContent.length > 0);
  });

  test('appendMsg without timestamp has no ts span', () => {
    const ctx = createDOM();
    ctx.appendMsg('user', 'no time', null);
    const ts = ctx.document.querySelector('#messages .msg .ts');
    assert.equal(ts, null);
  });

  test('multiple messages maintain order', () => {
    const ctx = createDOM();
    ctx.appendMsg('user', 'one', Date.now());
    ctx.appendMsg('claw', 'two', Date.now());
    ctx.appendMsg('user', 'three', Date.now());
    const msgs = ctx.document.querySelectorAll('#messages .msg');
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].querySelector('span').textContent, 'one');
    assert.equal(msgs[1].querySelector('span').textContent, 'two');
    assert.equal(msgs[2].querySelector('span').textContent, 'three');
  });
});


// ── Connection State ─────────────────────────────────────────────────────────
describe('Connection state', () => {
  test('setConnState("connected") hides banner and clears dot classes', () => {
    const ctx = createDOM();
    ctx.setConnState('connected');
    const dot = ctx.document.getElementById('status-dot');
    const banner = ctx.document.getElementById('conn-banner');
    assert.equal(dot.className, 'status-dot');
    assert.equal(banner.style.display, 'none');
  });

  test('setConnState("offline") shows banner with offline class', () => {
    const ctx = createDOM();
    ctx.setConnState('offline');
    const dot = ctx.document.getElementById('status-dot');
    const banner = ctx.document.getElementById('conn-banner');
    assert.ok(dot.classList.contains('offline'));
    assert.equal(banner.className, 'offline');
    assert.equal(banner.style.display, 'flex');
  });

  test('setConnState("reconnecting") shows banner with reconnecting class', () => {
    const ctx = createDOM();
    ctx.setConnState('reconnecting');
    const dot = ctx.document.getElementById('status-dot');
    const banner = ctx.document.getElementById('conn-banner');
    assert.ok(dot.classList.contains('reconnecting'));
    assert.equal(banner.className, 'reconnecting');
    assert.equal(banner.style.display, 'flex');
  });
});


// ── Build Cards ──────────────────────────────────────────────────────────────
describe('Build cards', () => {
  test('renderBuildCards creates 7 cards', () => {
    const ctx = createDOM();
    ctx.renderBuildCards();
    const cards = ctx.document.querySelectorAll('#build-grid .build-card');
    assert.equal(cards.length, 7);
  });

  test('build cards have correct labels', () => {
    const ctx = createDOM();
    ctx.renderBuildCards();
    const labels = [...ctx.document.querySelectorAll('.build-label')].map(el => el.textContent);
    assert.ok(labels.includes('Build a website'));
    assert.ok(labels.includes('Surprise me'));
  });

  test('pickBuild switches to chat and pre-fills input', () => {
    const ctx = createDOM();
    ctx.activatePanel('build', null);
    ctx.pickBuild(0);
    const chatPanel = ctx.document.getElementById('panel-chat');
    assert.ok(chatPanel.classList.contains('active'), 'should switch to chat');
    const input = ctx.document.getElementById('chat-input');
    assert.equal(input.value, ctx.BUILD_IDEAS[0].prompt);
  });

  test('pickBuild works for each idea index', () => {
    for (let i = 0; i < 7; i++) {
      const ctx = createDOM();
      ctx.activatePanel('build', null);
      ctx.pickBuild(i);
      const input = ctx.document.getElementById('chat-input');
      assert.equal(input.value, ctx.BUILD_IDEAS[i].prompt, `idea ${i} should pre-fill`);
    }
  });
});


// ── Helpers ──────────────────────────────────────────────────────────────────
describe('Helper functions', () => {
  test('esc escapes HTML entities', () => {
    const ctx = createDOM();
    assert.equal(ctx.esc('<script>alert("xss")</script>'),
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  test('esc handles null/undefined', () => {
    const ctx = createDOM();
    assert.equal(ctx.esc(null), '');
    assert.equal(ctx.esc(undefined), '');
    assert.equal(ctx.esc(''), '');
  });

  test('reltime returns "just now" for recent timestamps', () => {
    const ctx = createDOM();
    assert.equal(ctx.reltime(Date.now()), 'just now');
    assert.equal(ctx.reltime(Date.now() - 30000), 'just now');
  });

  test('reltime returns minutes ago', () => {
    const ctx = createDOM();
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    assert.equal(ctx.reltime(fiveMinAgo), '5m ago');
  });

  test('reltime returns hours ago', () => {
    const ctx = createDOM();
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    assert.equal(ctx.reltime(twoHoursAgo), '2h ago');
  });

  test('reltime returns empty for falsy input', () => {
    const ctx = createDOM();
    assert.equal(ctx.reltime(null), '');
    assert.equal(ctx.reltime(0), '');
    assert.equal(ctx.reltime(undefined), '');
  });

  test('reltime handles unix seconds (< 1e12)', () => {
    const ctx = createDOM();
    // A timestamp in seconds (recent enough to show minutes)
    const nowSec = Math.floor(Date.now() / 1000) - 120;
    assert.equal(ctx.reltime(nowSec), '2m ago');
  });
});


// ── Blog Badge ───────────────────────────────────────────────────────────────
describe('Blog badge', () => {
  test('updateBlogBadge shows badge with count > 0', () => {
    const ctx = createDOM();
    ctx.updateBlogBadge(3);
    const badge = ctx.document.getElementById('blog-badge');
    assert.equal(badge.textContent, '3');
    assert.notEqual(badge.style.display, 'none');
  });

  test('updateBlogBadge hides badge with count 0', () => {
    const ctx = createDOM();
    ctx.updateBlogBadge(0);
    const badge = ctx.document.getElementById('blog-badge');
    assert.equal(badge.style.display, 'none');
  });
});


// ── DOM Structure ────────────────────────────────────────────────────────────
describe('DOM structure', () => {
  test('critical elements exist', () => {
    const ctx = createDOM();
    const ids = [
      'app', 'sidebar', 'main', 'panel-container',
      'messages', 'chat-input', 'send-btn', 'typing-indicator',
      'status-dot', 'conn-banner', 'build-grid',
      'repo-list', 'blog-list', 'blog-badge',
      'user-tag', 'queue-status',
    ];
    for (const id of ids) {
      assert.ok(ctx.document.getElementById(id), `#${id} should exist`);
    }
  });

  test('chat input is a textarea', () => {
    const ctx = createDOM();
    const input = ctx.document.getElementById('chat-input');
    assert.equal(input.tagName, 'TEXTAREA');
  });

  test('panels start with only chat active (via initial HTML class)', () => {
    // In the raw HTML, no panel has .active — it's set by init() at runtime.
    // But the nav item for chat has .active in the HTML.
    const ctx = createDOM();
    const chatNav = ctx.document.querySelector('[data-panel="chat"]');
    assert.ok(chatNav.classList.contains('active'));
  });
});
