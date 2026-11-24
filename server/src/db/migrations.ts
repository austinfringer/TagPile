/**
 * Ordered list of schema migrations. Append new entries; never edit or reorder
 * existing ones once they have shipped.
 */
export interface Migration {
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    name: '0001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT,
        password_hash TEXT NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked BOOLEAN NOT NULL DEFAULT 0,
        replaces TEXT,
        FOREIGN KEY (replaces) REFERENCES refresh_tokens (id),
        FOREIGN KEY (user_id) REFERENCES users (id)
      );

      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        code_hash TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked BOOLEAN NOT NULL DEFAULT 0,
        used BOOLEAN NOT NULL DEFAULT 0,
        is_admin BOOLEAN NOT NULL DEFAULT 0,
        issuer_id TEXT,
        claimant_id TEXT,
        FOREIGN KEY (issuer_id) REFERENCES users (id),
        FOREIGN KEY (claimant_id) REFERENCES users (id)
      );


      -- A library is a workspace: exactly one root directory, its own members and its own
      -- tag vocabulary. Libraries may not nest (enforced in library_operations.ts).
      CREATE TABLE libraries (
        library_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE roles (
        role_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        can_read BOOLEAN NOT NULL DEFAULT 0,
        can_create_tag BOOLEAN NOT NULL DEFAULT 0,
        can_tag_files BOOLEAN NOT NULL DEFAULT 0,
        can_manage_library BOOLEAN NOT NULL DEFAULT 0
      );
      INSERT INTO roles (name, can_read, can_create_tag, can_tag_files, can_manage_library) VALUES
        ('owner',  1, 1, 1, 1),
        ('editor', 1, 1, 1, 0),
        ('viewer', 1, 0, 0, 0);

      CREATE TABLE library_members (
        library_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        role_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (library_id, user_id),
        FOREIGN KEY (library_id) REFERENCES libraries (library_id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (role_id) REFERENCES roles (role_id)
      );

      CREATE TABLE IF NOT EXISTS invitation_library_members (
        invitation_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        role_id INTEGER NOT NULL,
        PRIMARY KEY (invitation_id, library_id),
        FOREIGN KEY (invitation_id) REFERENCES invitations (id) ON DELETE CASCADE,
        FOREIGN KEY (library_id) REFERENCES libraries (library_id) ON DELETE CASCADE,
        FOREIGN KEY (role_id) REFERENCES roles (role_id)
      );

      -- Content identity, global across libraries: one row per distinct hash.
      -- Which libraries can see a file is derived from its locations.
      CREATE TABLE files (
        file_id INTEGER PRIMARY KEY,
        file_hash TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL
      );

      -- A path (relative to the library root) at which a file's content was found.
      -- extension/type/created_at/modified_at are the location's file metadata, written by
      -- the scan; search selectors (type:image, extension:png, created_at:>...) read them.
      -- NULL until a scan with a stat-capable fs records them.
      CREATE TABLE locations (
        location_id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        library_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        missing BOOLEAN NOT NULL DEFAULT 0,
        previous_file_id INTEGER,
        extension TEXT,
        type TEXT,
        created_at INTEGER,
        modified_at INTEGER,
        UNIQUE (library_id, path),
        FOREIGN KEY (file_id) REFERENCES files (file_id) ON DELETE CASCADE,
        FOREIGN KEY (library_id) REFERENCES libraries (library_id) ON DELETE CASCADE,
        FOREIGN KEY (previous_file_id) REFERENCES files (file_id) ON DELETE SET NULL
      );
      CREATE INDEX idx_locations_file_id ON locations (file_id);

      CREATE TABLE tags (
        tag_id INTEGER PRIMARY KEY,
        library_id INTEGER NOT NULL,
        is_category BOOLEAN NOT NULL DEFAULT 0,
        -- Number of file instances (file_tag_relationships rows) of this tag. Maintained
        -- by tagFile/untagFile so usage and autocomplete need no recount. Tag-on-tag
        -- relationships are not counted.
        file_count INTEGER NOT NULL DEFAULT 0,
        -- UI color, a CSS color string such as "#ff8800". NULL means the default color.
        color TEXT,
        -- Wiki-style markdown writeup for the tag page.
        wiki_text TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (library_id) REFERENCES libraries (library_id) ON DELETE CASCADE
      );

      -- library_id is denormalized from tags so name lookups need no join. Alias text is
      -- unique among siblings only (docs/tags.md): the write path checks it, not the db.
      CREATE TABLE aliases (
        alias_id INTEGER PRIMARY KEY,
        tag_id INTEGER NOT NULL,
        library_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        is_primary BOOLEAN NOT NULL DEFAULT 0,
        is_shorthand BOOLEAN NOT NULL DEFAULT 0,
        FOREIGN KEY (tag_id) REFERENCES tags (tag_id) ON DELETE CASCADE,
        FOREIGN KEY (library_id) REFERENCES libraries (library_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_aliases_library_text ON aliases (library_id, text);
      CREATE INDEX idx_aliases_tag_id ON aliases (tag_id);
      CREATE UNIQUE INDEX idx_aliases_primary ON aliases (tag_id) WHERE is_primary = 1;

      CREATE TABLE file_tag_relationships (
        file_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (file_id, tag_id),
        FOREIGN KEY (file_id) REFERENCES files (file_id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags (tag_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_ftr_tag_id ON file_tag_relationships (tag_id);

      CREATE TABLE file_tag_values (
        value_id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        FOREIGN KEY (file_id, tag_id) REFERENCES file_tag_relationships (file_id, tag_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_ftv_file_tag ON file_tag_values (file_id, tag_id);
      CREATE INDEX idx_ftv_tag_id ON file_tag_values (tag_id);

      CREATE TABLE file_tag_value_anchor (
        value_id INTEGER PRIMARY KEY REFERENCES file_tag_values (value_id) ON DELETE CASCADE,
        t_start REAL, t_end REAL,
        rx REAL, ry REAL, rw REAL, rh REAL
      );

      CREATE TABLE file_tag_value_text (
        value_id INTEGER PRIMARY KEY REFERENCES file_tag_values (value_id) ON DELETE CASCADE,
        text_value TEXT NOT NULL
      );

      CREATE TABLE file_tag_value_number (
        value_id INTEGER PRIMARY KEY REFERENCES file_tag_values (value_id) ON DELETE CASCADE,
        num_value REAL NOT NULL
      );

      CREATE TABLE file_tag_value_tag (
        value_id INTEGER PRIMARY KEY REFERENCES file_tag_values (value_id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL,
        ref_tag_id INTEGER NOT NULL,
        FOREIGN KEY (file_id, ref_tag_id) REFERENCES file_tag_relationships (file_id, tag_id) ON DELETE CASCADE
      );


      CREATE TABLE tag_tag_relationships (
        subject_tag_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (subject_tag_id, tag_id),
        CHECK (subject_tag_id <> tag_id),
        FOREIGN KEY (subject_tag_id) REFERENCES tags (tag_id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags (tag_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_ttr_tag_id ON tag_tag_relationships (tag_id);

      CREATE TABLE tag_tag_values (
        value_id INTEGER PRIMARY KEY,
        subject_tag_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        FOREIGN KEY (subject_tag_id, tag_id) REFERENCES tag_tag_relationships (subject_tag_id, tag_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_ttv_subject_tag_id ON tag_tag_values (subject_tag_id);
      CREATE INDEX idx_ttv_tag_id ON tag_tag_values (tag_id);
      -- At most one parent value and one component value per instance.
      CREATE UNIQUE INDEX idx_ttv_structural ON tag_tag_values (subject_tag_id, tag_id, kind)
        WHERE kind IN ('parent', 'component');

      CREATE TABLE tag_tag_value_text (
        value_id INTEGER PRIMARY KEY REFERENCES tag_tag_values (value_id) ON DELETE CASCADE,
        text_value TEXT NOT NULL
      );

      CREATE TABLE tag_tag_value_number (
        value_id INTEGER PRIMARY KEY REFERENCES tag_tag_values (value_id) ON DELETE CASCADE,
        num_value REAL NOT NULL
      );

      -- The component tag is the instance's tag_id; the payload holds the flags.
      CREATE TABLE tag_tag_value_component (
        value_id INTEGER PRIMARY KEY REFERENCES tag_tag_values (value_id) ON DELETE CASCADE,
        recursive BOOLEAN NOT NULL DEFAULT 0,
        attributed BOOLEAN NOT NULL DEFAULT 0
      );

      CREATE TABLE tag_tag_value_tag (
        value_id INTEGER PRIMARY KEY REFERENCES tag_tag_values (value_id) ON DELETE CASCADE,
        subject_tag_id INTEGER NOT NULL,
        ref_tag_id INTEGER NOT NULL,
        FOREIGN KEY (subject_tag_id, ref_tag_id) REFERENCES tag_tag_relationships (subject_tag_id, tag_id) ON DELETE CASCADE
      );

      -- subject_tag_id is copied from the base row so the index can allow one primary
      -- parent per tag.
      CREATE TABLE tag_tag_value_parent (
        value_id INTEGER PRIMARY KEY REFERENCES tag_tag_values (value_id) ON DELETE CASCADE,
        subject_tag_id INTEGER NOT NULL,
        is_primary BOOLEAN NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX idx_ttv_parent_primary ON tag_tag_value_parent (subject_tag_id) WHERE is_primary = 1;

      -- Transitive closure over "parent" values: a self row per tag, plus one row per
      -- reachable descendant. No depth column: in a DAG one pair can have more than one depth.
      CREATE TABLE tag_ancestors (
        ancestor_id INTEGER NOT NULL,
        descendant_id INTEGER NOT NULL,
        PRIMARY KEY (ancestor_id, descendant_id),
        FOREIGN KEY (ancestor_id) REFERENCES tags (tag_id) ON DELETE CASCADE,
        FOREIGN KEY (descendant_id) REFERENCES tags (tag_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_tag_ancestors_descendant ON tag_ancestors (descendant_id);


      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        options TEXT CHECK (options IS NULL OR json_valid(options)),
        status_data TEXT CHECK (status_data IS NULL OR json_valid(status_data)),
        error TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id)
      );
    `,
  },
];
