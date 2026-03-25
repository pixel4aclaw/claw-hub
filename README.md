# 🐾 Claw Hub

A collaborative AI-powered development platform running on a Pixel 4a in Termux. ~40 developers experiment with building projects together, powered by Claude (Opus) as the resident AI agent — **Claw**.

**Live at:** [clawhub.us](https://clawhub.us)
**Repo:** [github.com/pixel4aclaw/claw-hub](https://github.com/pixel4aclaw/claw-hub)

## What Is This?

Claw Hub is a single-page web app where users chat with Claw, an AI agent that can read, write, and execute code directly on the server. It's not a wrapper around a chat API — Claw has full access to the filesystem, shell, and network. Users can ask Claw to build websites, games, modify the app itself, or run scheduled tasks.

### Key Features

- **Multi-user chat** — Persistent conversations with per-user session memory (50-message context window)
- **Agent queue system** — FIFO message processing with real-time queue position updates
- **Live collaboration** — Socket.io for real-time status, online presence, mail notifications
- **System dashboard** — Battery, thermals, disk, memory, CPU, network stats (Android-specific)
- **Mail system** — User-to-user messaging and Claw broadcasts
- **Repo tracking** — Auto-tracked project entries for any project (internal or external)
- **Blog** — Community blog posts
- **PWA support** — Service worker, manifest, push notifications
- **Commit watcher** — Real-time "Ship It!" animations when new commits land (broadcast to all users)
- **Desktop & mobile responsive** — Optimized layouts for both

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│   Browser    │◄───►│  Express +   │◄───►│  Queue Worker   │
│  (SPA)       │ ws  │  Socket.io   │     │  (worker.js)    │
└─────────────┘     └──────────────┘     └───────┬────────┘
                           │                      │ fork()
                     ┌─────┴─────┐         ┌──────┴────────┐
                     │  SQLite   │         │  Agent Child   │
                     │  (sql.js) │         │  (Claude SDK)  │
                     └───────────┘         └───────────────┘
```

- **server.js** — Express server, REST API, Socket.io, auth, rate limiting
- **worker.js** — Polls queue, spawns agent subprocess, manages sessions
- **agent-child.js** — Isolated Claude SDK subprocess (detached process group to survive SIGINT)
- **db.js** — SQLite schema, migrations, persistence
- **auth.js** — Cookie-based session auth with HMAC-SHA256 signatures

## API Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/api/login` | POST | Authenticate with username + password |
| `/api/me` | GET | Current user info |
| `/api/users` | GET | List users with message counts |
| `/api/chat` | POST | Send message to Claw |
| `/api/chat/retry` | POST | Retry last failed message |
| `/api/messages` | GET | Chat history |
| `/api/queue-status` | GET | Current queue state |
| `/api/mail` | GET | User mailbox |
| `/api/mail/broadcast` | POST | Send mail to all users |
| `/api/repos` | GET/POST/DELETE | Manage project repos |
| `/api/blog` | GET/POST | Blog posts |
| `/api/status` | GET | System metrics |
| `/api/health` | GET | Health check |

## Setup

```bash
# Clone
git clone https://github.com/pixel4aclaw/claw-hub.git
cd claw-hub

# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# ANTHROPIC_API_KEY=your-key
# SITE_PASSWORD=your-password
# COOKIE_SECRET=your-secret

# Start
npm start
```

Runs on port `3000` by default (override with `PORT` env var).

## Tech Stack

- **Runtime:** Node.js on Termux (Android)
- **AI:** Claude Opus via `@anthropic-ai/claude-agent-sdk`
- **Server:** Express 5 + Socket.io 4
- **Database:** SQLite via sql.js
- **Frontend:** Vanilla HTML/CSS/JS (single-page app, no build step)
- **Auth:** Signed cookie sessions (HMAC-SHA256)

## Contributing

This is a collaborative experiment. Chat with Claw in the app to propose changes, or open a PR directly. Claw can modify its own codebase — most features were built by asking it to.

---

*Built on a Pixel 4a. Powered by Claude. Maintained by humans and one very opinionated AI.*
