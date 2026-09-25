# LARO Desktop — Project Overview

LARO (Legal AI Reach Out) is a Dutch legal-assistance and lawyer-outreach desktop
application. It helps a case owner describe a case, collect and organize evidence,
classify the case into legal areas, match lawyers, prepare and (after human
approval) send outreach, track responses, and export an evidence package.

> **Status note (2026-07-06):** This document describes the **actual shipped
> architecture**. An earlier version described a Docker + MySQL + Redis stack that
> does not exist in this repository; that has been corrected. For the honest
> feature-by-feature status see [`docs/PRODUCT_DEFINITION.md`](docs/PRODUCT_DEFINITION.md)
> and [`docs/CRITICAL_PATH.md`](docs/CRITICAL_PATH.md). For the full phase audit see
> [`docs/phase-audit.md`](docs/phase-audit.md).

## 🏗️ Actual Architecture

LARO is a **single-process Electron desktop app** that boots an **embedded
Express + tRPC server in the Electron main process** and serves a **React SPA**.
There is **no Docker, no MySQL, and no Redis**. Persistence is **local SQLite**.

```
Electron main process (src-main/index.ts)
  ├─ starts the backend in-process:  import('../server/index').startServer(3000)
  │     ├─ Express + tRPC at /api/trpc            (server/index.ts, server/routers/*)
  │     └─ SQLite via Drizzle + better-sqlite3    (server/db.ts → userData/laro-server.sqlite)
  ├─ a second local SQLite DB for scanner state   (src-main/database.ts → userData/laro-agent.db)
  └─ BrowserWindow loads http://localhost:3000
        └─ React SPA (src/renderer) → tRPC client → /api/trpc
```

- **Frontend / Renderer**: React 18, Vite, Tailwind CSS, Radix (shadcn-style),
  TanStack Query v4, tRPC client, `wouter` router. Dual mode: full dashboard, plus
  a `?mode=scanner` desktop mini-app.
- **Desktop layer (Electron)**: TypeScript main process — window management, local
  file scanning, IPC bridge (`contextIsolation: true`), and starting the backend.
- **Backend (in-process, not a separate service)**: Express 4 + tRPC 10, Drizzle ORM.
- **Persistence**: SQLite (`better-sqlite3`) in the OS `userData` directory. **Not**
  MySQL/Redis.
- **File storage**: AWS S3 (`@aws-sdk/client-s3`) for evidence blobs, when configured.

## 🛠️ Technology Stack (as built)

- **Core**: TypeScript, Node.js 20+.
- **Frontend**: React 18, Vite, Tailwind, Radix UI, Lucide icons, TanStack Query, tRPC client, wouter.
- **Backend API**: Express, tRPC, Drizzle ORM (in-process inside Electron).
- **Persistence**: SQLite via `better-sqlite3` (two local DBs: server data + scanner state).
- **Storage**: AWS S3 (evidence), when `AWS_S3_*` env is set.
- **Desktop / packaging**: Electron, electron-builder (Windows target active; mac job commented out in CI).
- **AI**: pluggable LLM via `server/llm.ts` (Manus Forge endpoint; falls back to a labelled mock when no key).

## 📁 Project Structure (actual)

```text
/
├── src-main/        # Electron main process (entry, agent DB, preload, scanner, uploader)
├── src/renderer/    # React SPA (dashboard + scanner mini-app)
├── server/          # Express + tRPC backend + services (runs in-process)
├── shared/          # Shared types/const/exclusions  (NB: duplicated at src/shared — to be merged)
├── scripts/         # Dev/one-off utilities (scrapers, matching harnesses, build hooks)
├── drizzle/         # SQLite migrations
├── tests/           # Vitest (legacy suite has broken imports; see docs/phase-audit.md)
└── docs/            # Audit, architecture, critical-path, product-definition artifacts
```
There is **no** `electron/`, `docker/`, or `docker-compose.yml` in this repository.

## ⚙️ Development & Build

### Prerequisites
- **Node.js** v20+ (Docker is **not** required).

### Local development
```bash
npm install        # installs deps and rebuilds better-sqlite3 for Electron
npm run dev        # Vite (renderer) + Electron concurrently
# server only:  npm run dev:server
```

### Tests
```bash
npx vitest run tests/smoke   # critical-path smoke suite (see docs/CRITICAL_PATH.md)
```

### Packaging
```bash
npm run build      # renderer + main + server
npm run dist:win   # Windows portable build via electron-builder
```

## 🔒 Security & Connectivity (current state, honestly)

- **Auth**: email/password (bcrypt) + JWT session cookie for the tRPC API.
- **OAuth 2.0**: Google (Gmail/Drive) and Microsoft (Outlook) authorization-code
  primitives. Trello and Telegram connector stacks are retired and have no
  mounted credential or import surface; Slack remains unavailable.
- **Local persistence**: SQLite in `userData`. (No MySQL instance exists.)
- **Known security gaps** (tracked, not yet fixed — see `docs/phase-audit.md` §4/§7):
  default `JWT_SECRET`/`COOKIE_SECRET`, a `local-default` bearer backdoor, IDOR on
  some public endpoints, weak OAuth-token encryption, and `.env` being bundled into
  the packaged app. These are scheduled for Phases 006/007/008/030/100 and must be
  closed before any production claim.

## 🚧 Not implemented / aspirational

The following were described in earlier docs but are **not** built: Docker
life-cycle management, MySQL, Redis, Slack integration, document parsing/OCR,
PDF/zip export, and Stripe billing. Treat them as roadmap, not features. See
`docs/DEPENDENCY_AUDIT.md` and `docs/phase-audit.md`.

---
*Corrected 2026-07-06 to match the real codebase (Phase 004 / Phase 075 documentation-truthfulness).*
