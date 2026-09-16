# Repository guidance

## Core architecture docs (must stay in sync)

This fork's core architecture guides live in `docs/core/` (written in Chinese). Changes to the code below **must update the matching doc**:

| Doc | Covers | Triggered by changes to |
| --- | --- | --- |
| `docs/core/overview.md` | Process topology, data & persistence, auth, build & deploy | `server/index.ts`, `server/modules/database/{schema,migrations}.ts`, build output layout, deployment |
| `docs/core/providers.md` | Engine integration framework & capability matrix | `server/modules/providers/**`, `server/shared/{types,interfaces}.ts` |
| `docs/core/chat.md` | Chat pipeline & the frontend timeline store | `server/modules/websocket/**`, `src/modules/chat/**` |
| `docs/core/frontend.md` | Frontend state layering, performance rules, i18n, PWA | `src/shared/**`, chat rendering/perf code |

Rules:

- **Architecture only, no trivia.** Update docs when interfaces, protocols, extension points, capabilities, or performance invariants change; keep the docs lean, not long.
- **Ordinary bug fixes that don't touch architecture: just `git commit --no-verify`.** Never pad the architecture docs just to satisfy the check.
- The pre-commit guard (`scripts/hooks/check-doc-sync.mjs`) blocks core-code commits whose doc wasn't staged; its error message spells out these two exits.
- Upstream's `docs/architecture/` (six English chat-runtime docs) is maintained via upstream merges; 04/05 are partially superseded by this fork's rework — treat `docs/core/chat.md` as authoritative.

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Service Operations & Process Management

The **production instance** runs from a global pnpm install (`~/Library/pnpm/global/5/node_modules/cloudcli`) as a static copy fully detached from this repo — editing repo code or running dev here never affects it. PM2 persists its config in `~/.pm2/ecosystem.config.cjs` (process env vars must live there; PM2-managed processes never read `.zshrc`).

- Application name: `cloudcli`
- Publish a new build: `pnpm run deploy` (build → pack → global install → PM2 cutover → `pm2 save`). Run it in a terminal **outside** any cloudcli-hosted session — the cutover drops the session's own server.
- Service port: `3030` (`http://localhost:3030`)
- Restart command: `pm2 restart cloudcli`
- Logs command: `pm2 logs cloudcli`
- Status command: `pm2 status`
- Local dev keeps the defaults (`3001` server + `5173` vite), so dev and production coexist; after config changes run `pm2 save` so `pm2 resurrect` doesn't restore a stale snapshot.

Always use PM2 commands when restarting or inspecting the server process, rather than running ad-hoc background node processes.

**Important Note on Server Restarts**:
Restarting the PM2 service will abruptly drop the live websocket/HTTP connection with the user interface. Before triggering `pm2 restart cloudcli`, always send a message to the user informing them in advance that the service is about to restart and connection will temporarily drop. After the restart, wait for the user to send a prompt to resume and continue the work.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.
