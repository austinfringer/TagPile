# Changelog

All important changes to TagPile are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). TagPile uses [Semantic Versioning](https://semver.org/). While the version is 0.x, a minor release can contain changes that are not compatible with the previous release.

## [Unreleased]

## [0.1.0] - 2026-11-24

The first public release.

### Added

- Libraries: one root directory each, with their own members, roles, and tag vocabulary. Admins choose the directories with `LIBRARY_ROOTS`.
- Library scan job: finds files, hashes them, and records when the content at a path changes. The scan does not follow symbolic links.
- JSON import job for tags and values.
- Tags with aliases, parents, components, typed values, and wiki pages. A Manage tags page with a tree and a graph view.
- Tag search with a query language (see `docs/tags.md`).
- Image previews, with a separate cache database.
- Accounts by invitation code. The first admin invitation is printed in the server log.
- Sessions with one refresh token for each device, logout, password change, and user removal by an admin.
- Login and invitation rate limits.
- A public health check at `GET /api/health`.
- Built-in HTTPS with your certificate and key files (`TLS_CERT_FILE`, `TLS_KEY_FILE`), or plain HTTP for a trusted network.
- Security headers on all responses, and a strict sandbox for file content.
- Standalone builds for Linux, Windows, and macOS.

[Unreleased]: https://github.com/austinfringer/TagPile/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/austinfringer/TagPile/releases/tag/v0.1.0
