# Library-scoped tag, file, and search API

All routes are under `/api/libraries/:libraryId`. The `libraryScope` middleware (`server/src/routes/libraryScope.ts`) resolves the library and the caller's role:

- A caller who is not a member gets `404 { error: 'Library not found' }`.
- A caller whose role does not have the capability gets `403`.
- A file or tag id outside the library gets `404`.
- Errors are JSON: `{ error, opIndex?, fileId?, tagId? }`. `400` = bad input or query syntax, `404` = not found, `409` = conflict (cycle, sibling alias clash, last alias, duplicate value).

Client wrappers are in `client/src/lib/api.ts`.

## Search and autocomplete (`can_read`)

| Method | Path                              | Response                                                                                                                                                                                                                                                                                               |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/files?q=&limit=&offset=&count=` | `{ total, files: FileSummary[] }`. `limit` defaults to 100 and is clamped to 500. `count=0` skips the count of all matches and gives `total: null`. Use it for the pages after the first page of a search.                                                                                             |
| GET    | `/autocomplete?q=&limit=`         | `{ from, to, completions: [{ text, kind, tagId?, fileCount?, parent?, primary? }] }`. `limit` defaults to 10, max 50. Only the last token at the end of `q` is completed. Replace `q.slice(from, to)` with `text`. `primary` is the tag's primary alias when the match came through a secondary alias. |

`FileSummary` = `{ fileId, name, path, type, extension, size, missing, locationCount }`.

## Files

| Method | Path                                | Capability      | Response                                                                                                                                                                                                                         |
| ------ | ----------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/files/:fileId`                    | `can_read`      | `{ file, locations, instances, tags }`                                                                                                                                                                                           |
| POST   | `/files/query`                      | `can_read`      | Body `{ ids (1–500), include?: ['locations', 'instances'] }`. Response `{ files, notFound, tags? }` (`tags` included when `include` has `'instances'`).                                                                          |
| PUT    | `/files/:fileId/tags/:tagId`        | `can_tag_files` | `204`. Idempotent. Component tags come along.                                                                                                                                                                                    |
| DELETE | `/files/:fileId/tags/:tagId`        | `can_tag_files` | `204`                                                                                                                                                                                                                            |
| POST   | `/files/:fileId/tags/:tagId/values` | `can_tag_files` | Body `{ kind: 'text', text }`, `{ kind: 'number', number }`, `{ kind: 'tag', refTagId }` or `{ kind: 'anchor', anchor: { tStart?, tEnd?, rx?, ry?, rw?, rh? } }`. Response `201 { value }`. The tag must already be on the file. |
| PATCH  | `/files/:fileId/values/:valueId`    | `can_tag_files` | Body `{ kind, ... }` matching the value's kind. Response `200 { value }`.                                                                                                                                                        |
| DELETE | `/files/:fileId/values/:valueId`    | `can_tag_files` | `204`                                                                                                                                                                                                                            |
| POST   | `/files/batch`                      | `can_tag_files` | Body `{ fileIds (1–500), ops (1–50) }`. Response `{ files: FileSummary[] }`.                                                                                                                                                     |

Batch ops: `{ op: 'tag', tagId }`, `{ op: 'untag', tagId }`, `{ op: 'addValue', tagId, value }` (applies the tag first), `{ op: 'clearValues', tagId }`. The server checks every id and op first, then runs all ops in one transaction. One failure rolls back everything, and the error body names `opIndex` and `fileId`.

## Tags

Reads need `can_read`. Writes need `can_create_tag`.

| Method | Path                                   | Response                                                                                                                               |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/tags?q=&limit=&offset=`              | `{ total, tags: [{ tagId, name, color, isCategory, fileCount, parentName }] }`. `q` is an alias prefix. Order: `fileCount` descending. |
| POST   | `/tags`                                | Body `{ alias, color?, isCategory?, parentId?, wikiText? }`. Response `201 { tag: TagDetail }`.                                        |
| GET    | `/tags/:tagId`                         | `{ tag: TagDetail }` = `{ tag, aliases, instances, parents, ancestors, children, descendants, tags }`                                  |
| PATCH  | `/tags/:tagId`                         | Body `{ color?, isCategory?, wikiText? }`. Response `{ tag }`.                                                                         |
| DELETE | `/tags/:tagId`                         | `204`. `409` when its children would become roots that clash.                                                                          |
| POST   | `/tags/:tagId/aliases`                 | Body `{ text }`. Response `201 { tag }`.                                                                                               |
| PATCH  | `/tags/:tagId/aliases/:aliasId`        | Body `{ text?, primary?: boolean, shorthand?: boolean }`. Response `{ tag }`.                                                          |
| DELETE | `/tags/:tagId/aliases/:aliasId`        | `204`. `409` for the last alias.                                                                                                       |
| PUT    | `/tags/:tagId/parents/:parentId`       | Body `{ primary? }`. `204`. `409` on a cycle or sibling clash.                                                                         |
| DELETE | `/tags/:tagId/parents/:parentId`       | `204`                                                                                                                                  |
| PUT    | `/tags/:tagId/components/:componentId` | Body `{ recursive?, attributed? }`. `204`. Adds or updates.                                                                            |
| DELETE | `/tags/:tagId/components/:componentId` | `204`                                                                                                                                  |
| PUT    | `/tags/:tagId/tags/:refTagId`          | `204`                                                                                                                                  |
| DELETE | `/tags/:tagId/tags/:refTagId`          | `204`                                                                                                                                  |
| POST   | `/tags/:tagId/tags/:refTagId/values`   | Body `{ kind: 'text' \| 'number' \| 'tag', ... }`. Response `201 { value }`.                                                           |
| PATCH  | `/tags/:tagId/values/:valueId`         | Body `{ kind, ... }` matching the value's kind. Response `200 { value }`.                                                              |
| DELETE | `/tags/:tagId/values/:valueId`         | `204`                                                                                                                                  |

`GET /tag-graph` returns `{ tags, edges }` for the Manage tags page. `tags` holds every tag of the library, ordered by name: `{ tagId, name, color, isCategory, fileCount, parentName, aliases }`. `edges` holds every tag-tag relationship: `{ subjectTagId, tagId, parent, primary, component, valueCount }`. `valueCount` counts the values that are not `parent` or `component`.

Alias text must be unique among siblings (see `tags.md`). The empty text and `*` are rejected.

The global `GET /api/files/:id` stays. It is the cross-library view of one file.

## Not done yet

- `group_by` in queries (returns `400`).
- Copying values in `migrateFileData` when file content changes.
- Thumbnails, previews, and member management routes.
