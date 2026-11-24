# AGENTS.md

Guidance for AI agents and contributors working in this repo.

## Reporting and writing conventions

Use Orwell's rules and ASD-STE100 Simplified Technical English (STE) as practical filters for clear, direct, and honest prose. Use STE by default for technical, instructional, business, and product prose. Apply the rules to both drafting and revision, but do not erase deliberate voice, character, rhythm, humor, or genre when the user clearly wants them.

STE has writing rules and a controlled dictionary. Use an approved word with its approved meaning when the dictionary is available. Do not claim strict STE conformance without checking the current ASD-STE100 issue and dictionary.
Core Rules

Remember these rules from "Politics and the English Language":

- Never use a metaphor, simile, or other figure of speech which you are used to seeing in print.
- Never use a long word where a short one will do.
- If it is possible to cut a word out, always cut it out.
- Never use the passive where you can use the active.
- Never use a foreign phrase, a scientific word, or a jargon word if you can think of an everyday English equivalent.
- Break any of these rules sooner than say anything outright barbarous.

ASD-STE100 baseline

For technical and instructional prose:

- Use short sentences. Put one main action or statement in each sentence.
- Use a clear subject and an active verb. Name the actor when the actor matters.
- Use the same term for the same thing. Do not change a term only to avoid repetition.
- Use familiar words with one precise meaning. Avoid idioms, slang, figurative language, and vague verbs.
- Use a specific technical term when it is necessary for accuracy. Define it or link to its definition.
- Keep noun groups short. Use prepositions to show relationships between terms.
- Write procedures as direct instructions. State the condition, action, and expected result.
- Use positive instructions when they are clear. State what the reader must do.
- Use consistent American English spelling unless the user's style guide requires another variety.
- Preserve code, commands, identifiers, product names, legal text, and required quotations. Do not simplify them silently.

When strict STE is not possible, keep the text clear and mark the terms or passages that need a domain-specific exception.

## Stack

- npm workspaces monorepo: `client/` (Vite 8, Svelte 5 runes, SASS, TS), `server/` (Express 5, better-sqlite3, TS), and `e2e/` (Playwright).
- Node 24 LTS via nvm (`.nvmrc`). Run `source ~/.nvm/nvm.sh && nvm use` before npm commands if the shell's node is older.
- TypeScript 6 with `verbatimModuleSyntax` + `erasableSyntaxOnly`. Server source imports use explicit `.ts` extensions (rewritten to `.js` on build).

## Verification (run before finishing any change)

```sh
npm run ci           # format:check + lint + typecheck + test + build
```

Or individually: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Auto-fix formatting with `npm run format` and lint with `npm run lint:fix`.

## Testing conventions

- Vitest in both workspaces. Test files live next to the code as `*.test.ts`.
- Server: use `createTestApp()` / `createTestDb()` from `server/src/test/helpers.ts` (in-memory SQLite, migrations applied). HTTP tests use `supertest` against the Express app, no real port.
- Client: unit-test logic in `.ts` modules; component tests use `@testing-library/svelte` with jsdom. The `resolve.conditions: ['browser']` setting in `vite.config.ts` is required for Svelte 5 component tests.
- E2E: Playwright tests in `e2e/tests/*.spec.ts`, run with `npm run test:e2e` (builds client+server, then starts the real production server against a temp SQLite file and runs the suite against it — see `e2e/playwright.config.ts`). `e2e/global-setup.ts` seeds a test user (`TEST_USER`) directly into that database, since there's no public signup endpoint. Not part of `npm run ci`/`npm test` since it needs a build and downloaded browsers (`npx playwright install chromium` once, from `e2e/`).
- Manual/acceptance testing: `npm run dev` does **not** exercise production behavior (e.g. the auth-gated page routes in `server/src/app.ts` only register when `NODE_ENV=production`, and the client is served unauthenticated by Vite). To click through the app as it behaves in production, run `npm run acceptance` — builds client+server and starts the real server (`NODE_ENV=production`, its own `JWT_SECRET`) on port 4000 against `server/data/acceptance.sqlite` (gitignored, separate from your dev DB). Watch the console for the first-run invitation code.

## Server conventions

- `createApp()` in `server/src/app.ts` must stay side-effect free (no `listen`, no file I/O) so it is testable. Only `index.ts` starts the server.
- All API routes are mounted under `/api`. Unknown `/api/*` paths return JSON `404`.
- Three route groups come before `authMiddleware` in `app.ts`: `authRouter` (login, refresh, logout), `healthRouter` (`GET /api/health`; it adds `version` and `uptime` only for a caller with a valid JWT), and `POST /api/invitation/redeem`. To test the auth middleware, use a protected route such as `GET /api/auth/me`, not `/api/health`.
- Jobs live in memory. At startup `index.ts` calls `failInterruptedJobRecords` to mark queued and running job rows as failed. Job summaries carry `canManage` (the caller may halt or delete); the client shows Halt and Delete only when it is true.
- Library-scoped routes go under `/api/libraries/:libraryId` behind `libraryScope` (`routes/libraryScope.ts`; use `requireCapability` for writes and `sendError` from `routes/util.ts` to map `db/errors.ts` errors to 400/404/409). See `docs/TagSearchAPI.md`.
- Library roots come from the operator, not from the web UI. `POST /api/libraries` and a `rootPath` change in `PUT /api/libraries/:id` need an admin (`requireAdmin` in `routes/util.ts`). `validateRootPath` in `routes/libraries.ts` resolves symbolic links, then accepts only a directory in `config.libraryRoots` (`LIBRARY_ROOTS`) that does not overlap the directory of `DATABASE_PATH`. An empty list rejects every path. Each rejected path gets the same error; keep it that way so the reply does not show what exists on the server.
- Schema changes go in `server/src/db/migrations.ts` as new appended entries (`0002_...`, `0003_...`). `0001_init` is frozen since the first public release (0.1.0): do not edit, reorder, or remove a migration, because user databases already ran it. A migration must upgrade an existing database with data in it, so test it against a database created by the previous migrations, not only an empty one.
- Query planner statistics: `index.ts` calls `optimizeDatabase()` (`PRAGMA optimize`, in `db/index.ts`) after the database opens and before it closes. `JobManager` calls it when a job completes or fails. Without statistics SQLite can pick a slow index.
- Search (`db/search_operations.ts`) compiles a tag term with a value filter to `files.file_id IN (SELECT v.file_id FROM file_tag_values v ...)`. Keep this subquery free of references to the outer `files` row. A correlated subquery runs one time for each file.
- The preview cache lives in its own SQLite file, `previews.sqlite` next to `DATABASE_PATH` (created or loaded by `index.ts`, passed to `createServices(db, previewsDb)`). It is disposable cache data: `PreviewService` creates its `previews` table on open, so it has no migrations and can be deleted at any time. A stray `previews` table in the core db is leftover from before the split and can be dropped.

## Data model

- A **library** is a workspace: exactly one `root_path`, its own `library_members` (via `roles` with capability flags) and its own `tags`/`aliases` vocabulary. Libraries may not nest; `library_operations.ts` rejects overlapping roots.
- **`files` is global and content-addressed** (one row per `file_hash`). A `location` is a root-relative path in one library pointing at a file; the same bytes in two libraries are one file with two locations. `locations.previous_file_id` records what a path held before its content changed.
- **Visibility is derived from locations**: a user may see a file iff it has a location (missing or not) in a library they belong to. Always read files/tags through the `getVisible*` helpers in `file_operations.ts` (or `visibleFilesClause`) and filter tags by `tags.library_id`; never return raw tag/file rows from a route.
- Per-library data must never live on `files`. Tag copies on content change (`migrateFileData`) are restricted to the scanning library. Files with no locations are garbage (`deleteOrphanFiles`).
- Config comes from `loadConfig()` in `config.ts`; add new env vars there and in `.env.example`.
- Sessions: each login creates its own refresh token (one per device). `POST /api/auth/refresh` rotates the presented token only; a rotated token that comes back after a 30-second grace time revokes every session of that user (reuse detection). Logout revokes the presented token; a password change (`POST /api/auth/password`) revokes all of them and starts a new session. `authMiddleware` rejects a JWT whose user is gone or whose `iat` is older than `users.updated_at`. Login (by username and by IP) and invitation redemption (by IP) have in-memory failure limits (`rateLimit.ts`). Passwords: 8 or more characters, at most 72 UTF-8 bytes (`validation.ts`; the client copy is `passwordProblem` in `api.ts`).
- TLS: `TLS_CERT_FILE` + `TLS_KEY_FILE` make `index.ts` serve HTTPS (and `createApp` adds HSTS); otherwise it serves HTTP and warns when `HOST` is not loopback. `COOKIE_SECURE` and `TRUST_PROXY` are for a reverse proxy in front.
- Page-level auth gating (not just `/api`) happens server-side in `app.ts`: `/login` (and hashed `/assets/*`) are served with no auth check; every other page path verifies the `jwt` cookie (`verifyJwtCookie` in `routes/auth.ts`) and redirects to `/login` if it's missing/invalid, before any client JS runs. Renewal of an expired JWT happens client-side: `client/src/lib/api.ts` refreshes the session (via the `/api/auth/refresh` route and the shared `refreshSession`/`setAuthCookies` helpers in `routes/auth.ts`) and retries on a 401.

## Client conventions

- Svelte 5 runes (`$state`, `$effect`, `$props`), not legacy `export let` / stores unless needed.
- Runes only work in `.svelte` and `.svelte.ts`/`.svelte.js` modules, and importers must use the explicit `.svelte` extension (e.g. `import { navigate } from './lib/router.svelte'`) — plain extensionless imports don't resolve to `.svelte.ts` files.
- Styles: `<style lang="scss">` in components; shared variables in `client/src/styles/_variables.scss`, imported with `@use '../styles/variables' as *;`.
- API calls go through `client/src/lib/api.ts` and accept an injectable `fetch` for testability. On a 401, calls refresh the session and retry once (`refreshSession` / `fetchWithRefresh`); concurrent 401s share one refresh so rotated refresh tokens don't race. Only `login`/`redeem` skip this (they are pre-auth).
- Two separate Vite build entries (multi-page app, see `vite.config.ts`'s `build.rollupOptions.input`): `login.html` (public, mounts `Login.svelte` via `login-main.ts`) and `index.html` (the protected app shell, mounts `App.svelte` via `main.ts`). Add new protected pages/components under the `index.html`/`main.ts` entry; the login page stays self-contained.
- In-app navigation is a tiny pushState router in `client/src/lib/router.svelte.ts` (`/`, `/tag`, `/tags`, `/tags/:id`, `/jobs`, `/jobs/:id`, `/settings`); no router dependency.
- The Manage tags page (`/tags`, `client/src/pages/ManageTagsPage.svelte`) loads the full tag graph from `GET /api/libraries/:libraryId/tag-graph`. Its logic is in `client/src/lib/tagGraph/`: `model.ts` (indexes, tree rows, the drawn subgraph) and `layout.ts` (layered SVG layout) are pure modules with unit tests. The graph view is hand-written SVG; there is no graph dependency.
- Job-type UI lives in a client registry (`client/src/lib/jobs/registry.ts`): each job type registers a label, a New-job `Options` form, `describe`/`counters` presentation, and an optional `Details` component. Add new job types under `client/src/lib/jobs/<type>/` and import them in `client/src/lib/jobs/index.ts`.
- Component tests must call `cleanup()` from `@testing-library/svelte` in `afterEach` (vitest globals are off, so cleanup is not automatic).
- The app-wide context menu (`client/src/lib/contextmenu/`) is driven by data attributes: give an element `data-context="tag"` (+ `data-tag-id`, `data-tag-name`, and `data-attached-file` when the tag is attached to a file) or `data-context="file"` (+ `data-file-id`, `data-file-name`) and a single delegated listener builds the menu from them. Copy/Paste/Select All always appear; Ctrl+right-click bypasses the custom menu and shows the native one.

## Tooling notes

- Git hooks (Husky): pre-commit runs lint-staged; pre-push runs typecheck + test + build.
- npm 11 blocks install scripts unless listed in `allowScripts` in the root `package.json`. When adding a dependency with native/postinstall steps, run `npm install-scripts approve <pkg>` and commit the resulting change.
- When adding dependencies, prefer versions published at least a week ago (check with `npm view <pkg> time`).
- Standalone portable builds: `npm run build:standalone` (`scripts/build-standalone.mjs`) builds the client, bundles the server into a single CJS file with esbuild, embeds the client assets into a Node 24 Single Executable Application (SEA) blob (`node --experimental-sea-config`), injects it into official Node 24 binaries with `postject`, and writes platform zip archives (`linux-x64`, `win-x64`, `darwin-arm64`, `darwin-x64`) into `dist/`. Pass `-- --target=host` (or `-- --target=linux-x64`) to build a single target.
- Releases: push a `vX.Y.Z` tag to run `.github/workflows/release.yml`. The tag must match `version` in the root and `server/` `package.json`, and `CHANGELOG.md` must have a `## [X.Y.Z]` section (it becomes the release notes). The workflow builds the Linux and Windows zips on Ubuntu and the macOS zips on macOS (they need `codesign`), then creates a draft GitHub release with the zips and `SHA256SUMS.txt`. Publish the draft by hand.
