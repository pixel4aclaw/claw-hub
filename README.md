# Claw Hub

A collaborative AI-powered development platform where ~40 developers experiment with building projects together, powered by Claw — an AI agent running on a Pixel 4a with Termux.

## What is this?

Claw Hub is a real-time chat app with an embedded AI agent (Claw) that can:

- **Build things on demand** — websites, games, tools, scheduled tasks
- **Modify itself** — Claw can edit the chat app's own code
- **Watch commits** — live "Ship It!" animations when code is pushed (Twitch-style)
- **Stream chain-of-thought** — see what Claw is thinking in real-time over WebSockets
- **Send push notifications** — alerts when queued responses complete (PWA + Web Push)

## Architecture

```
Pixel 4a (Termux)
├── server.js          Express + Socket.io server
├── worker.js          Queue processor — spawns Claude agent subprocesses
├── agent-child.js     Isolated Claude SDK child process (streams progress via IPC)
├── auth.js            Cookie-based authentication
├── db.js              SQLite (sql.js) — users, messages, sessions, repos, queue
└── public/
    ├── index.html     SPA frontend (vanilla JS, Socket.io client)
    ├── sw.js          Service worker for PWA + push notifications
    └── manifest.json  PWA manifest for iOS/Android install
```

## Key Features

### Real-time Commit Watcher
Polls `git rev-parse HEAD` every 5s across all repos. When a new commit lands, broadcasts a "Ship It!" overlay animation to all connected users via Socket.io. No LLM calls — purely deterministic.

### Agent Queue System
Messages are queued in SQLite. A single worker processes them sequentially, spawning isolated child processes for each Claude invocation. Supports session resumption, rate-limit parking, and retry.

### Chain-of-Thought Streaming
The Claude Agent SDK streams thinking/tool-use events via an async iterator. These are forwarded over Socket.io so users can watch Claw work in real-time — zero extra API tokens.

### Desktop + Mobile Responsive
Responsive layout with breakpoints at 900px and 1200px. PWA-installable on iOS/Android.

## Running

```bash
# Install dependencies (also installs git hooks)
npm install

# Set environment variables
cp .env.example .env  # Add your ANTHROPIC_API_KEY

# Start the server
npm start

# Run tests
npm test
```

## Tech Stack

- **Runtime:** Node.js on Termux (Pixel 4a)
- **Server:** Express 5 + Socket.io 4
- **AI:** Anthropic Claude Agent SDK (Opus)
- **Database:** SQLite via sql.js (in-process, no native bindings)
- **Frontend:** Vanilla JS SPA — no build step, no framework
- **Auth:** Cookie-based with bcrypt-compatible hashing

## License

ISC
