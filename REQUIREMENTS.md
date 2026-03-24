# Claw Hub — Requirements

> A collaborative, experimental AI town where developers interact with Claw (an AI agent) and each other through a persistent, delightful world.

---

## 1. Identity & Naming

- Project name: **Claw Hub**
- AI agent referred to as: **Claw**
- Running on: Pixel 4a, Termux, Linux

---

## 2. Access & Authentication

### Site Password
- Single shared password required to enter the site: `[stored in .env]`
- **Username**: open-ended — any string is accepted. No per-user password.
- Login is remembered via **cookie** (session cookie or long-lived signed cookie)
- Username becomes the user's persistent identity

### Username Behavior
- Same username = same user across sessions (state persists)
- Username is chosen at login and tied to all future state
- Usernames should be treated as case-insensitive for matching

---

## 3. The Town

### Landing Page
- **Canvas-based** scrollable world displaying the town
- Starts centered on **Town Hall**
- Smooth panning/zooming
- Each entity in the town is a clickable building

### Town Hall
- Central building, always present
- Click → opens **Town Status Page**
- Status page shows: active users, recent activity, current projects, town rules

### User Buildings
- Every user gets their own building in the town
- Building is **auto-generated** on first login based on username (Claw picks something fun and fitting)
- On first login, user is **asked what they want their building to become** — they can describe it and Claw customizes it
- Building has its own **building page** (auto-generated, delightful, personalized)
- Buildings can be modified over time via chat

### Town Rules
- Users can propose/vote on town rules via chat
- Rules affect the world (Claw enforces/implements them)

---

## 4. Chat System

### Floating Chat Button
- Always visible on every page
- Opens a chat panel showing that user's **full conversation history with Claw**
- History restored from database on load

### Message Queue
- All messages go to a **deterministic queue** (no LLM involvement in queue logic)
- Queue ordered by receipt time
- Each user can see their **current position in the queue**
- Position displayed in the chat UI instantly

### Claw's Processing
- Claw processes messages **in order**, with full conversation context per user
- Each user's messages are scoped to their own conversation history
- **Optimization note**: With many users, context window management will need work — consider summarization, truncation, or tiered memory strategies

---

## 5. Database

- **SQLite** (via `better-sqlite3`)
- Tables needed:
  - `users` — id, username (unique), created_at, building_type, building_description, building_page_html
  - `messages` — id, user_id, role (user/assistant), content, created_at, queue_position
  - `queue` — id, user_id, message_id, status (pending/processing/done), created_at, started_at, completed_at
  - `town_state` — key/value store for global town config, rules, building positions
  - `buildings` — id, user_id, name, type, description, x, y, width, height, page_html, created_at, updated_at

---

## 6. Capabilities (What Users Can Do via Chat)

- Modify their own building (appearance, description, page content)
- Modify the town (add buildings, change layout, propose rules)
- Create new sub-projects (Claw creates GitHub repos, deploys at nested URLs)
- Ask Claw to do almost anything within the Termux environment
- View town history, user activity, building pages

---

## 7. Sub-Projects & Nested Deployments

- Claw can create **private GitHub repos** (under `pixel4aclaw`)
- Repos can be deployed as nested URLs: `<main-url>/<project-name>/`
- Cloudflare Tunnel routes traffic to appropriate local ports
- Sub-projects tracked in database and displayed in town

---

## 8. Health & Reliability

### Health Checks
- `/api/health` endpoint (already exists) — extend with DB status, queue depth, active connections
- Periodic self-checks (e.g., every 5 minutes)

### End-to-End Tests
- Basic E2E tests: login flow, chat send/receive, building page loads
- Run on deploy or on-demand

### Alerting
- If health checks fail: Claw gets notified **outside the broken service** (e.g., via Telegram)
- Claw can then investigate, roll back, or fix forward
- Alert threshold: 2 consecutive failures

### Rollback Strategy
- Git-based: each deploy tagged, can revert
- Claw manages restarts via PM2 or similar

---

## 9. Process Management

- Use **PM2** to keep the server alive and auto-restart on crash
- Logs accessible for debugging
- Graceful shutdown handling

---

## 10. Open Questions / Future Work

- [ ] Domain registration + Cloudflare zone setup for permanent URL
- [ ] Password rotation mechanism (currently hardcoded in .env)
- [ ] Rate limiting per user to prevent queue flooding
- [ ] Context window optimization for high user volume
- [ ] Town map persistence and visual design iteration
- [ ] Mobile-friendly canvas interactions
- [ ] Websocket vs HTTP polling for queue status updates (Socket.io already in place)

---

## Implementation Order

1. ✅ Hello world server (Express + Socket.io)
2. ✅ Cloudflare Tunnel (quick tunnel running)
3. **Auth middleware** (password + cookie, username selection)
4. **SQLite setup** (schema, migrations)
5. **Town canvas** (landing page with scrollable world)
6. **User login flow** (username → building generation)
7. **Chat system** (queue, history, Claw integration)
8. **Building pages** (auto-generated per user)
9. **Health checks + alerting**
10. **Sub-project deployment infrastructure**
