# Tags

## Queries

A query is a list of terms. A term is either a **command** or a **set term**.

- **Command**: changes how results are returned (`sort:created_at`, `group_by:type`). Commands are global and can appear anywhere in the top-level list.
- **Set term**: a filter that returns a set of files. Set terms are intersected with each other and can be combined with `and`, `or`, `not`.
- **Selector**: a set term that is a leaf and reads the db directly. Examples: a tag, a fs query (files in a directory), a file metadata query, a value query.

A selector is made of a **specifier** (which tag or metadata field) and an optional **filter** (a condition on its value).

### File metadata

Reserved names map to file metadata: `created_at`, `modified_at`, `size`, `type`, `extension`, etc. They need a value or a comparison: `type:image`, `size:>100MB`, `created_at:>2023-01-01`.

## Data model

There are tags, instances, and values.

- A **tag** is a named, per-library entry with aliases. A tag can be marked as a **category**. This is a UI hint for organizing tags and for disambiguation. It has no effect on search.
- An **instance** is a tag applied to a **subject**. A subject is a file or another tag. There is at most one instance per `(subject, tag)`.
- A **value** is a piece of typed data attached to an instance. An instance can have any number of values, of any kinds, including several of the same kind.

Depth is fixed: `subject -> instance -> values`. Values do not have values.

File instances and tag instances have the same shape and live in parallel tables (`file_tag_*` and `tag_tag_*`). The tables are separate because they have different foreign keys, different allowed value kinds, and different checks (cycles only matter for tags), and because a file search never has to scan tag-tag rows.

### Value kinds

| Kind        | Holds                                                   | On          | Example                                                 |
| ----------- | ------------------------------------------------------- | ----------- | ------------------------------------------------------- |
| `text`      | free text                                               | files, tags | `Description:"..."`, `Title:"The thing"`, `Cat:"Mario"` |
| `number`    | numeric value                                           | files, tags | `Page:4`, `Rating:8`                                    |
| `tag`       | a reference to another instance on the same subject     | files, tags | `Author:Tolkien`, `Cat:Orange`                          |
| `anchor`    | a place in the file: time range, region, or both        | files       | grandma at 00:05:30, at (x, y, w, h)                    |
| `parent`    | marks the applied tag as a parent of the subject tag    | tags        | `mario` tagged `character` with `parent`                |
| `component` | marks the applied tag as a component of the subject tag | tags        | `mario` tagged `overalls` with `component`              |

- The kind lives on the value, not on the tag. Any tag can hold any kind.
- If an instance has two values of the same kind, they are treated the same: shown as a list and searched as a group. If the UI ever needs to tell them apart, promote that meaning to its own tag.
- Anchor time is `t_start`/`t_end`. Anchor region is `rx, ry, rw, rh`, stored as fractions from 0 to 1 so it works at any image size.
- When adding a value in the UI, default to the kind this tag uses most in the library, but let the user pick any kind.

#### `tag` values reference instances, not tags

A `tag` value on instance `(file, A)` points at another instance `(file, B)` on the same file. It does not point at tag `B` directly. So `Cat:Orange` means: the file is tagged `Cat`, the file is tagged `Orange`, and the `Cat` instance has a value that points at the `Orange` instance.

Consequences:

- When the user adds `Cat:Orange` and `Orange` is not yet on the file, apply `Orange` first, then add the value.
- Every tag used as a value is also applied to the file. A bare search for `orange` finds the orange cat. A search for an author name finds everything they are on, whatever the values say. `*:orange` still narrows to files where `Orange` is used as a value.
- Removing the `Orange` instance removes every value that points at it (foreign key cascade). Removing `Cat` removes the `Cat` instance and its values; `Orange` stays applied.
- Chains are possible: `Mario -> Shorts -> Blue`. Everything needed to draw the hierarchy is in the instances and values of one file, so the client can build it with no extra queries.

### Tag-tag relationships

A tag can be tagged. `tag_tag_relationships(subject_tag_id, tag_id)` is an instance of `tag_id` applied to `subject_tag_id`. Both tags must be in the same library. A tag cannot tag itself. These instances take `text`, `number`, and `tag` values like file instances do, plus two kinds that change behavior: `parent` and `component`.

#### `parent`

`mario` tagged `character` with a `parent` value makes `character` a parent of `mario`.

- One way. `character` knows nothing about `mario` except through the closure table.
- Transitive in search. `character` matches files tagged `mario`. The file row only holds `mario`; nothing is copied. This relationship is structural, not flattened.
- No cycles. Adding parent `P` to tag `T` is rejected if `P = T` or if `T` is already an ancestor of `P`. This is one lookup in the closure table. Check it on submission, in the same transaction as the write.
- Multiple parents are allowed (a DAG, not a tree). A parent can be marked `primary`. At most one primary parent per tag.
- Disambiguation in the UI, when several tags share a name: show the primary parent; otherwise the nearest ancestor that is a category; otherwise any parent.
- Components are not inherited through parents. A child brings only its own components. Deferred: this could become an option on the `parent` value (apply the parent's components on hop).

#### `component`

`mario` tagged `overalls` with a `component` value makes `overalls` a component of `mario`.

- Flattened on apply. When `mario` is applied to a file, `overalls` is also applied as its own instance. The `overalls` instance gets a `tag` value that points at the `mario` instance. The UI shows this as `overalls` being a subtag of `mario`.
- Independent after apply. The user can remove `overalls` (or the link value) without changing `mario` or anything else. Removing `mario` removes the link value; `overalls` stays applied.
- If `overalls` is already on the file, no new instance is made. Only the link value is added if it is missing.
- Components are applied at apply time only. Changing a tag's components later does not change files that already have it.
- Payload settings:
  - `recursive`: if true, `overalls` also brings along its own components, each linked to `overalls`. Follow the flag at each hop. Use a visited set; because there is one instance per `(file, tag)`, this terminates even if the component graph has a cycle. Cycles are allowed here.
  - `attributed`: if true, the `mario` instance also gets a `tag` value that points at the `overalls` instance. Then `mario:overalls` matches as well as `overalls:mario`.

The purpose is to attach tags that usually come with a main tag, so tagging is fast, while the user can still fine-tune the result to match the content. Example: a character and the outfit they usually wear.

### Schema

```sql
CREATE TABLE tags (
  tag_id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL,
  is_category BOOLEAN NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (library_id) REFERENCES libraries (library_id) ON DELETE CASCADE
);

-- `tag_id` is always the applied tag. The subject is `file_id` or `subject_tag_id`.

CREATE TABLE file_tag_relationships (
  file_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (file_id, tag_id),
  FOREIGN KEY (file_id) REFERENCES files (file_id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags (tag_id) ON DELETE CASCADE
);

-- A value is one base row plus exactly one payload row in the table named by `kind`.
-- `kind` has no CHECK: SQLite cannot change a CHECK without a table rebuild, so a new
-- kind is a new payload table plus an entry in the route's kind registry, nothing more.

CREATE TABLE file_tag_values (
  value_id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  FOREIGN KEY (file_id, tag_id) REFERENCES file_tag_relationships (file_id, tag_id) ON DELETE CASCADE
);
-- indexes: (file_id, tag_id), (kind)

CREATE TABLE file_tag_value_text (
  value_id INTEGER PRIMARY KEY REFERENCES file_tag_values (value_id) ON DELETE CASCADE,
  text_value TEXT NOT NULL
);
-- FTS5 table over text_value

CREATE TABLE file_tag_value_number (
  value_id INTEGER PRIMARY KEY REFERENCES file_tag_values (value_id) ON DELETE CASCADE,
  num_value REAL NOT NULL
);
-- index: (num_value)

CREATE TABLE file_tag_value_tag (
  value_id INTEGER PRIMARY KEY REFERENCES file_tag_values (value_id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL,     -- copied from the base row so the FK can enforce "same file"
  ref_tag_id INTEGER NOT NULL,  -- the tag of another instance on the same file
  FOREIGN KEY (file_id, ref_tag_id) REFERENCES file_tag_relationships (file_id, tag_id) ON DELETE CASCADE
);
-- index: (file_id, ref_tag_id)
-- The route (or a trigger) keeps file_id equal to the base row and ref_tag_id <> the base row's tag_id,
-- and rejects a second tag value with the same ref_tag_id on one instance.

CREATE TABLE file_tag_value_anchor (
  value_id INTEGER PRIMARY KEY REFERENCES file_tag_values (value_id) ON DELETE CASCADE,
  t_start REAL, t_end REAL,
  rx REAL, ry REAL, rw REAL, rh REAL
  -- CHECK: a time part, a region part, or both
);

CREATE TABLE tag_tag_relationships (
  subject_tag_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (subject_tag_id, tag_id),
  CHECK (subject_tag_id <> tag_id),
  FOREIGN KEY (subject_tag_id) REFERENCES tags (tag_id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags (tag_id) ON DELETE CASCADE
);

CREATE TABLE tag_tag_values (
  value_id INTEGER PRIMARY KEY,
  subject_tag_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  FOREIGN KEY (subject_tag_id, tag_id) REFERENCES tag_tag_relationships (subject_tag_id, tag_id) ON DELETE CASCADE
);
-- indexes: (subject_tag_id, tag_id), (tag_id, kind)
-- unique: (subject_tag_id, tag_id, kind) WHERE kind IN ('parent', 'component')

-- text and number payloads: same shape as the file ones.
CREATE TABLE tag_tag_value_text (
  value_id INTEGER PRIMARY KEY REFERENCES tag_tag_values (value_id) ON DELETE CASCADE,
  text_value TEXT NOT NULL
);
CREATE TABLE tag_tag_value_number (
  value_id INTEGER PRIMARY KEY REFERENCES tag_tag_values (value_id) ON DELETE CASCADE,
  num_value REAL NOT NULL
);

CREATE TABLE tag_tag_value_tag (
  value_id INTEGER PRIMARY KEY REFERENCES tag_tag_values (value_id) ON DELETE CASCADE,
  subject_tag_id INTEGER NOT NULL,  -- copied from the base row
  ref_tag_id INTEGER NOT NULL,      -- the tag of another instance on the same subject tag
  FOREIGN KEY (subject_tag_id, ref_tag_id) REFERENCES tag_tag_relationships (subject_tag_id, tag_id) ON DELETE CASCADE
);

CREATE TABLE tag_tag_value_parent (
  value_id INTEGER PRIMARY KEY REFERENCES tag_tag_values (value_id) ON DELETE CASCADE,
  subject_tag_id INTEGER NOT NULL,  -- copied from the base row, for the primary index
  is_primary BOOLEAN NOT NULL DEFAULT 0
);
-- unique: (subject_tag_id) WHERE is_primary = 1

CREATE TABLE tag_tag_value_component (
  value_id INTEGER PRIMARY KEY REFERENCES tag_tag_values (value_id) ON DELETE CASCADE,
  recursive BOOLEAN NOT NULL DEFAULT 0,
  attributed BOOLEAN NOT NULL DEFAULT 0
);

-- Closure over `parent` values. Self row for every tag. No depth column:
-- in a DAG one pair can have more than one depth.
CREATE TABLE tag_ancestors (
  ancestor_id INTEGER NOT NULL,
  descendant_id INTEGER NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id),
  FOREIGN KEY (ancestor_id) REFERENCES tags (tag_id) ON DELETE CASCADE,
  FOREIGN KEY (descendant_id) REFERENCES tags (tag_id) ON DELETE CASCADE
);
-- index: (descendant_id)
```

### Parents and names

- A tag can have several parents. Paths like `pet/mario` and `character/mario` can both exist and point at different tags.
- Alias text must be unique among siblings: no two tags that share a parent can share an alias, and no two root tags (tags with no parent) can share an alias. With several parents there is no single `(library, parent, text)` key, so the db keeps a plain index on `aliases (library_id, text)` and the write path checks uniqueness, in the same transaction as the parent change or alias change.
- Alias text that contains `/`, `:`, `?`, or `~` must be quoted in a query. The text `*` on its own is reserved and cannot be an alias.
- A path `a/b/c` resolves to tags named `c` that have an ancestor named `b` that has an ancestor named `a`. This is one flat query that joins `tag_ancestors` once per segment, so a path still works if a tag is moved one level deeper.
- Update `tag_ancestors` in the same transaction when a `parent` value is added or removed, or when a tag is deleted. Rebuild the rows for the subject tag and all its descendants.
- "Search a parent, get its descendants" is one join, with no recursive lookups:
  `file_tag_relationships JOIN tag_ancestors ON descendant_id = tag_id WHERE ancestor_id = ?`
- The closure table applies to `ref_tag_id` too. If Person is a child of Creator, `author:creator` matches `Author:Person`.

## Search

| Term                            | Matches                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `cat`                           | Cat tag (or a descendant of it) on the file, applied directly or through a value |
| `pet/mario`                     | Only the Mario tag under Pet                                                     |
| `mario`                         | Every tag named Mario (union of all matches)                                     |
| `cat:"mario"`                   | Any text value on Cat equals "mario"                                             |
| `cat:~mario` / `cat:~"mario"`   | Any text value on Cat contains "mario"                                           |
| `cat:orange`                    | Any value on Cat matches as text or as a tag (union of kinds)                    |
| `cat:#orange`                   | Only tag values (optional explicit prefix)                                       |
| `mario:shorts:blue`             | Sugar for `mario:shorts shorts:blue`                                             |
| `page:>4`                       | Any number value on Page is greater than 4                                       |
| `cat:*`                         | Cat has any value                                                                |
| `cat?anchor` / `not cat?anchor` | Cat has / has no anchor values                                                   |
| `description:*`                 | File has any value on Description                                                |
| `*:person`                      | Person used as a tag value under any tag                                         |

Rules:

- **A bare term matches any instance on the file.** Tags used as values are also applied to the file, so `orange` returns the orange cat and `person` returns files tagged `Author:Person`. Use `*:person` to narrow to files where Person is a value.
- **A value filter matches if any value on the instance matches.**
- **Mismatched kinds don't match.** `page:>4` only checks number values. If a query value can be read as more than one kind, try every kind it parses as and return the union. Each kind is one join against its payload table; `cat:*` and `cat?kind` read the base table only.
- **`?` filters by kind, `:` filters by content.** `cat?text` is existence only. `cat?kind` is valid for `text`, `number`, `tag`, and `anchor`.
- **Chained `:` splits into pairs.** `a:b:c` is `a:b b:c`. Because there is one instance per `(file, tag)`, the split is exact: the `b` instance in both pairs is the same row.
- **Parents are transitive, components are not.** `character` matches a file tagged only `mario`. `mario` does not match a file tagged only `overalls`; a component is a separate instance that happens to point back at `mario`.

## Implementation notes

- When file content changes, `migrateFileData` copies instances and values along with tags, still limited to the scanning library. `ref_tag_id` points at a tag on the same file, so it copies unchanged.
- Read instances and values only through the `getVisible*` helpers, the same as tags.
- Writing a value is two inserts in one transaction: the base row, then the payload row in the table for `kind`. The server keeps a kind registry (`kind -> payload table, validate, read, write`); adding a kind means a new payload table in a migration and a new registry entry. The db does not enforce "exactly one payload row, in the right table"; the registry does.
- Reading an instance's values is one query on the base table plus one `LEFT JOIN` per payload table, or one query per kind present. Either way the result is keyed by `value_id`.
- Both tags in a `tag_tag_relationships` row, and `ref_tag_id` in either `*_value_tag` table, must be in the same library as `tag_id`. Check this in the route.
- Applying a tag to a file is one transaction: insert the instance, then walk `component` values (with the visited set) and insert each component instance and its link values, then `attributed` back-links.
- The `tag` view on the client builds the hierarchy from the subject's instances and values alone. No server-side graph walk is needed.
- Deferred: a nullable `key_tag_id` on values, to label values (`Cat { Name:"Mario", Color:Orange }`). Only add it if real use shows it's needed.
- Deferred: more than one instance of the same tag on a subject.
- Deferred: inheriting components through parents, as an option on the `parent` value.
