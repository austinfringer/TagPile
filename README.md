# TagPile

TagPile is a self-hosted web app to tag and find your files. You point it at directories on your server. It scans them, and you and the people you invite attach tags to the files. Then you search with a query language, for example `cat and not dog`, `rating:>7`, or `type:image size:>5MB`.

- **Libraries.** Each library is one directory with its own members, roles (owner, editor, viewer), and tag vocabulary.
- **Rich tags.** Tags have aliases, parents, components, and typed values: text, numbers, references to other tags, and places in a file (a time range or an image region). Each tag has a wiki page.
- **Search.** Combine tags, values, and file metadata with `and`, `or`, and `not`. See [`docs/tags.md`](docs/tags.md).
- **Content-addressed.** TagPile identifies a file by its hash, so tags stay when you move or rename the file in the library.
- **One process.** A Node.js server with SQLite. No other database or service is necessary. Standalone builds for Linux, Windows, and macOS need no Node.js installation.

> **Status:** early development (0.x). The data model and the API can change between minor versions. Make a backup of the `data/` directory before you upgrade.

## Install

### Standalone build

1. Download the zip for your system from the [releases page](https://github.com/austinfringer/TagPile/releases) and extract it.
2. Copy `.env.example` to `.env` in the same directory. Set `LIBRARY_ROOTS` (see [Library directories](#library-directories-library_roots)).
3. Run `start-tagpile.bat` (Windows), `start-tagpile.command` (macOS), or `./start-tagpile.sh` (Linux).
4. Do the [first-run steps](#first-run).

### From source

Requirements: Node.js 24 (`nvm use` reads `.nvmrc`) and npm 11 or later.

```sh
npm ci
cp .env.example .env    # then set LIBRARY_ROOTS and, if necessary, the TLS settings
npm run build
npm start               # serves the app on port 3000
```

### First run

On first start with an empty database, the server writes an invitation code to its log:

```
First time setup complete. Invitation code: 3f9c...
```

1. Open the app in a browser (`http://localhost:3000` by default).
2. On the login page, select **Have an invitation code? Redeem it**.
3. Enter a username, a password (8 or more characters), and the invitation code. This account is the first admin.

The code is valid for one hour. If it expires before you use it, start the server again to get a new code. Each start cancels the code from the start before it, so only the newest code works.

To add more people, go to **Settings > User management** and create an invitation. You choose the global role (member or admin) and a role in each library. Send the code to the person; TagPile shows it one time only.

## Deploy

TagPile has two network modes. Choose one before other people use the server.

### HTTPS (recommended)

Give TagPile a certificate and its private key, in PEM format:

```sh
TLS_CERT_FILE=/etc/tagpile/cert.pem
TLS_KEY_FILE=/etc/tagpile/key.pem
```

When both are set, the server will only use HTTPS, marks the session cookies `Secure`, and sends `Strict-Transport-Security`. The certificate must be valid for the name that people type in the browser. You can get one from your own certificate authority, from Let's Encrypt, or from a tool such as `mkcert` for a home network. Start the server again after you renew the certificate.

### Plain HTTP on a trusted network

When the TLS settings are not set, TagPile speaks plain HTTP. Passwords and session cookies then cross the network unencrypted, and a person on the same network can read them. Use this mode only:

- on one computer, with `HOST=127.0.0.1`, or
- on a home or office network where you trust all devices.

The server writes a warning at startup when it speaks plain HTTP on an address other than loopback.

### Behind a reverse proxy

If a reverse proxy (for example Caddy or nginx) ends HTTPS in front of TagPile, keep the TLS settings unset and set:

```sh
HOST=127.0.0.1        # only the proxy can connect
COOKIE_SECURE=true    # the browser sees HTTPS
TRUST_PROXY=loopback  # read the client address from X-Forwarded-For
```

`TRUST_PROXY` is necessary for the login rate limit: without it, all requests seem to come from the proxy.

### Backups

All data is in the directory of `DATABASE_PATH` (`data/` by default):

- `tagpile.sqlite`: users, libraries, tags, and the session secret. Back up this file.
- `previews.sqlite`: the preview cache. You can delete it at any time.

Stop the server before you copy the files, or use `sqlite3 tagpile.sqlite ".backup backup.sqlite"` while it runs. Do not put this directory in a library root.

## Configuration

Set environment variables, or put them in a `.env` file. `npm run dev` and `npm start` read `.env` from the repository root. A standalone build reads `.env` from the directory of the executable. See [`.env.example`](.env.example).

| Variable        | Default                 | Description                                                                                                                  |
| --------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PORT`          | `3000`                  | Server port.                                                                                                                 |
| `HOST`          | `0.0.0.0`               | Address to listen on. `0.0.0.0` accepts connections from the network; `127.0.0.1` from this computer only.                   |
| `DATABASE_PATH` | `./data/tagpile.sqlite` | SQLite file, created on first run. `:memory:` gives a database that the server deletes when it stops.                        |
| `NODE_ENV`      | —                       | `production` serves the built client and applies the page login checks. `npm start` and standalone builds set it.            |
| `LIBRARY_ROOTS` | — (empty)               | Directories that may hold libraries. See below.                                                                              |
| `TLS_CERT_FILE` | —                       | PEM certificate file. Set it together with `TLS_KEY_FILE` to serve HTTPS.                                                    |
| `TLS_KEY_FILE`  | —                       | PEM private key file.                                                                                                        |
| `COOKIE_SECURE` | `true` with TLS files   | `true` or `false`. Marks session cookies `Secure`. Set `true` behind a reverse proxy that ends HTTPS.                        |
| `TRUST_PROXY`   | `false`                 | `true`, a number of proxy hops, or addresses such as `loopback` or `10.0.0.0/8`. Use it only behind a reverse proxy.         |
| `JWT_SECRET`    | — (generated)           | Secret that signs session tokens. When unset, the server makes one on first start and keeps it in the database.              |
| `OPEN_BROWSER`  | —                       | `1` or `true` opens the app in the default browser at startup (`--open` does the same). The standalone start scripts set it. |

### Library directories (`LIBRARY_ROOTS`)

A library gives its members access to the files in one directory on the server. Only the person who operates the server decides which directories TagPile can use. The web UI cannot change this list.

`LIBRARY_ROOTS` is empty by default. While it is empty, no one can create a library. This is also true when the server listens only on `localhost`.

To permit libraries:

1. Open the `.env` file. For a standalone build, the `.env` file is in the same directory as the executable.
2. Set `LIBRARY_ROOTS` to the absolute paths of the directories that hold your files. Separate the paths with `:` on Linux and macOS, and with `;` on Windows.

   ```sh
   # Linux, macOS
   LIBRARY_ROOTS=/srv/media:/mnt/photos
   # Windows
   LIBRARY_ROOTS=D:\Media;E:\Photos
   ```

3. Start the server again. The server prints the list at startup.
4. Log in as an admin and create the library. Its root path must be one of the listed directories or a directory below one.
5. Open **Jobs** and start a library scan to add the files.

To add a directory later, add it to `LIBRARY_ROOTS` and start the server again.

Rules that the server applies:

- Only an admin can create a library or change the root path of a library. A library owner who is not an admin can rename or delete the library.
- The server resolves symbolic links before it compares paths. A link in a listed directory that points outside of the list is rejected.
- The scan does not follow symbolic links. It counts them as skipped.
- A library root cannot contain the directory of `DATABASE_PATH`, and cannot be in it. That directory holds password hashes and the session secret.
- The server gives the same error for each rejected path. The error does not show if the path exists.
- The server checks the list when a library is created or moved. A library that exists stays available if you remove its directory from the list. Delete the library to remove access.

Keep the list small. An admin account can read all files below the listed directories. Do not list `/`, a home directory, or a directory that holds the `.env` file. For more protection, run TagPile as a dedicated OS user that can read only these directories.

## Accounts and sessions

- Each login starts a session for that device. A session stays valid for 7 days after its last use.
- **Log out** in the left bar ends the session on this device.
- **Settings > Account** changes your password. This ends your sessions on all other devices.
- An admin can remove a user in **Settings > User management**. This ends all sessions of that user at once.
- After 10 failed logins for one username in 15 minutes, TagPile refuses logins for that username for the rest of the 15 minutes. One address can have 50 failures in 15 minutes.

## Development

```sh
npm install     # installs all workspaces and the Git hooks
npm run dev     # server on :3000, client on :5173 (proxies /api to the server)
```

Open http://localhost:5173.

TagPile does not accept pull requests at this time. You can report a bug or propose a feature in the [issue tracker](https://github.com/austinfringer/TagPile/issues).

### Scripts

| Command                    | What it does                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`              | Run the server (tsx watch) and the client (Vite HMR) together.                                                                |
| `npm run build`            | Build the client to `client/dist` and compile the server to `server/dist`.                                                    |
| `npm start`                | Run the compiled server in production mode. It also serves the built client.                                                  |
| `npm run acceptance`       | Build, then run the production server on `127.0.0.1:4000` with its own database (`server/data/acceptance.sqlite`).            |
| `npm run build:standalone` | Make standalone zips (`linux-x64`, `win-x64`, `darwin-arm64`, `darwin-x64`) in `dist/`. `-- --target=host` builds one.        |
| `npm test`                 | Run all unit and component tests (Vitest).                                                                                    |
| `npm run test:e2e`         | Build, then run the Playwright tests against the real server. Run `npx playwright install chromium` in `e2e/` one time first. |
| `npm run test:watch`       | Vitest in watch mode for the server (`-w client` for the client).                                                             |
| `npm run typecheck`        | `svelte-check` and `tsc` in all workspaces.                                                                                   |
| `npm run lint`             | ESLint. `npm run lint:fix` corrects what it can.                                                                              |
| `npm run format`           | Prettier. `npm run format:check` only checks.                                                                                 |
| `npm run ci`               | The full check: format, lint, typecheck, test, build. GitHub Actions runs the same check.                                     |
| `npm run clean`            | Remove the build output.                                                                                                      |

Workspace commands work too, for example `npm run test -w server`.

### Git hooks

Husky installs the hooks on `npm install`:

- **pre-commit**: `lint-staged` (ESLint `--fix` and Prettier on staged files)
- **pre-push**: `typecheck`, `test`, `build`

### Project layout

```
.
├── client/                 # Vite + Svelte 5 + SASS
│   └── src/
│       ├── lib/            # components, API client, router, job types, tag graph
│       ├── pages/          # one component for each page
│       ├── styles/         # shared SCSS variables
│       ├── App.svelte      # app shell (index.html, needs a session)
│       └── Login.svelte    # login page (login.html, public)
├── server/                 # Express 5 + better-sqlite3
│   └── src/
│       ├── db/             # schema migrations and data operations
│       ├── JobModules/     # library scan and JSON import jobs
│       ├── routes/         # Express routers
│       ├── services/       # job manager, preview cache
│       ├── test/           # shared test helpers
│       ├── app.ts          # createApp(): no listen(), no file I/O, so tests can use it
│       ├── config.ts       # environment variables
│       └── index.ts        # entry point: opens the database and starts HTTP or HTTPS
├── e2e/                    # Playwright tests
├── docs/                   # query language and API notes
├── scripts/                # standalone build, cross-platform script helper
└── package.json            # npm workspaces root
```

### Database migrations

Schema changes are SQL entries at the end of `server/src/db/migrations.ts`. The server runs each one time, in order, in a transaction, at startup. Never edit or reorder a migration that is in a release.

## License

Copyright the TagPile contributors. TagPile is free software under the [GNU Affero General Public License v3.0 or later](LICENSE). If you run a changed version of TagPile for other people over a network, you must offer them its source code.
