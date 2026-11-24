import type { Db } from './index.ts';
import { inClause } from './library_operations.ts';

/** Thrown when a query string does not parse (see docs/tags.md for the query language). */
export class SearchSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchSyntaxError';
  }
}

//AST

export type Specifier =
  | { type: 'any' } // bare `*`: any tag of the library
  | { type: 'path'; segments: string[] } // `mario`, `pet/mario`
  | { type: 'metadata'; name: MetadataField }; // reserved: size, type, extension, ...

export type MetadataField = 'size' | 'type' | 'extension' | 'created_at' | 'modified_at';

export type ValueFilter =
  | { type: 'any' } // `cat:*`
  | { type: 'value'; text: string; quoted: boolean; tagOnly: boolean; substring: boolean } // `cat:orange`, `cat:#orange`, `cat:~orange`
  | { type: 'compare'; op: CompareOp; operand: string }; // `page:>4`

export type CompareOp = '<' | '<=' | '>' | '>=' | '=';

export type Selector = {
  type: 'selector';
  specifier: Specifier;
  filters: ValueFilter[];
  kind: ValueKind | null; // `cat?anchor`
};

export type ValueKind = 'text' | 'number' | 'tag' | 'anchor';

export type QueryExpr =
  { type: 'and' | 'or'; children: QueryExpr[] } | { type: 'not'; child: QueryExpr } | Selector;

export type SortCommand = { field: 'size' | 'created_at' | 'modified_at'; descending: boolean };

export type ParsedQuery = {
  /** The set-term expression, or null for a query with only commands (matches everything). */
  expr: QueryExpr | null;
  sorts: SortCommand[];
  /** Parsed but unused by search(), which returns a flat id list. */
  groupBys: string[];
};

//Tokenizer. `:`, `?`, and `~` are punctuation outside quotes; words carry a `quoted` flag since
//quoting changes meaning (quoted values are text-only, quoted specifiers are never paths).

type WordToken = { t: 'word'; text: string; quoted: boolean };
type Token =
  | WordToken
  | { t: 'colon' }
  | { t: 'question' }
  | { t: 'tilde' }
  | { t: 'lparen' }
  | { t: 'rparen' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const isBoundary = (c: string) => /\s/.test(c) || '():"?~'.includes(c);
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ':' || ch === '?' || ch === '~') {
      tokens.push({
        t:
          ch === '('
            ? 'lparen'
            : ch === ')'
              ? 'rparen'
              : ch === ':'
                ? 'colon'
                : ch === '?'
                  ? 'question'
                  : 'tilde',
      });
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      let text = '';
      let closed = false;
      while (i < input.length) {
        const c = input[i]!;
        if (c === '\\' && i + 1 < input.length) {
          text += input[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        text += c;
        i++;
      }
      if (!closed) throw new SearchSyntaxError('Unterminated quoted string');
      tokens.push({ t: 'word', text, quoted: true });
      continue;
    }
    let text = '';
    while (i < input.length && !isBoundary(input[i]!)) {
      text += input[i];
      i++;
    }
    tokens.push({ t: 'word', text, quoted: false });
  }
  return tokens;
}

//Parser

const COMMAND_NAMES = new Set(['sort', 'group_by']);
const METADATA_FIELDS = new Set(['size', 'type', 'extension', 'created_at', 'modified_at']);
const VALUE_KINDS = new Set(['text', 'number', 'tag', 'anchor']);
const SORT_FIELDS = new Set(['size', 'created_at', 'modified_at']);
const JUXTAPOSITION_END_KEYWORDS = new Set(['and', 'or']);

const isWord = (tok: Token | undefined): tok is WordToken => tok?.t === 'word';

class Parser {
  private pos = 0;
  private readonly sorts: SortCommand[] = [];
  private readonly groupBys: string[] = [];

  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ParsedQuery {
    const children: QueryExpr[] = [];
    while (this.pos < this.tokens.length) {
      if (this.atCommand()) {
        this.parseCommand();
        continue;
      }
      children.push(this.parseOr());
    }
    return {
      expr:
        children.length === 0
          ? null
          : children.length === 1
            ? children[0]!
            : { type: 'and', children },
      sorts: this.sorts,
      groupBys: this.groupBys,
    };
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isKeyword(word: string): boolean {
    const tok = this.peek();
    return isWord(tok) && !tok.quoted && tok.text.toLowerCase() === word;
  }

  /** A command starts with a bare command name directly followed by `:`. */
  private atCommand(): boolean {
    const tok = this.peek();
    return (
      isWord(tok) &&
      !tok.quoted &&
      COMMAND_NAMES.has(tok.text.toLowerCase()) &&
      this.tokens[this.pos + 1]?.t === 'colon'
    );
  }

  private atTermStart(): boolean {
    const tok = this.peek();
    if (tok === undefined) return false;
    if (tok.t === 'lparen') return true;
    if (!isWord(tok)) return false;
    if (!tok.quoted && JUXTAPOSITION_END_KEYWORDS.has(tok.text.toLowerCase())) return false;
    return !this.atCommand();
  }

  private takeWord(expected: string): WordToken {
    const tok = this.tokens[this.pos++];
    if (!isWord(tok)) throw new SearchSyntaxError(`Expected ${expected}`);
    return tok;
  }

  private parseCommand() {
    const name = (this.takeWord('a command') as WordToken).text.toLowerCase();
    this.pos++; // the colon atCommand() verified
    const arg = this.takeWord(`an argument after "${name}:"`);
    if (name === 'sort') {
      let field = arg.text;
      let descending = false;
      if (field.startsWith('-')) {
        descending = true;
        field = field.slice(1);
      }
      field = field.toLowerCase();
      if (!SORT_FIELDS.has(field)) {
        throw new SearchSyntaxError(
          `Unknown sort field "${field}". Expected one of: ${[...SORT_FIELDS].join(', ')}`,
        );
      }
      this.sorts.push({ field: field as SortCommand['field'], descending });
    } else {
      this.groupBys.push(arg.text);
    }
  }

  private parseOr(): QueryExpr {
    const children = [this.parseAnd()];
    while (this.isKeyword('or')) {
      this.pos++;
      if (!this.atTermStart()) throw new SearchSyntaxError('Expected a term after "or"');
      children.push(this.parseAnd());
    }
    return children.length === 1 ? children[0]! : { type: 'or', children };
  }

  private parseAnd(): QueryExpr {
    const children = [this.parseUnary()];
    for (;;) {
      if (this.isKeyword('and')) {
        this.pos++;
        if (!this.atTermStart()) throw new SearchSyntaxError('Expected a term after "and"');
        children.push(this.parseUnary());
        continue;
      }
      if (this.atTermStart()) {
        children.push(this.parseUnary());
        continue;
      }
      break;
    }
    return children.length === 1 ? children[0]! : { type: 'and', children };
  }

  private parseUnary(): QueryExpr {
    if (this.isKeyword('not')) {
      this.pos++;
      return { type: 'not', child: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): QueryExpr {
    const tok = this.peek();
    if (tok === undefined) throw new SearchSyntaxError('Unexpected end of query');
    if (tok.t === 'lparen') {
      this.pos++;
      const inner = this.parseOr();
      if (this.tokens[this.pos++]?.t !== 'rparen') throw new SearchSyntaxError('Expected ")"');
      return inner;
    }
    if (tok.t === 'rparen') throw new SearchSyntaxError('Unmatched ")"');
    if (!isWord(tok)) {
      const symbol = tok.t === 'colon' ? ':' : tok.t === 'question' ? '?' : '~';
      throw new SearchSyntaxError(`Unexpected "${symbol}"`);
    }
    if (this.atCommand()) {
      throw new SearchSyntaxError(`Commands like "${tok.text}:" must appear at the top level`);
    }
    if (!tok.quoted && ['and', 'or', 'not'].includes(tok.text.toLowerCase())) {
      throw new SearchSyntaxError(`Expected a term, found "${tok.text}"`);
    }
    this.pos++;
    return this.parseSelector(tok);
  }

  private parseSelector(specTok: WordToken): QueryExpr {
    const specifier = parseSpecifier(specTok);
    const filters: ValueFilter[] = [];
    while (this.peek()?.t === 'colon') {
      this.pos++;
      if (this.peek()?.t === 'tilde') {
        this.pos++;
        const word = this.takeWord('a value after "~"');
        if (word.text === '') throw new SearchSyntaxError('Empty value');
        filters.push({
          type: 'value',
          text: word.text,
          quoted: word.quoted,
          tagOnly: false,
          substring: true,
        });
      } else {
        filters.push(parseFilter(this.takeWord('a value after ":"')));
      }
    }
    let kind: ValueKind | null = null;
    if (this.peek()?.t === 'question') {
      this.pos++;
      const kindTok = this.takeWord('a value kind after "?"');
      if (kindTok.quoted || !VALUE_KINDS.has(kindTok.text)) {
        throw new SearchSyntaxError(
          `Unknown value kind "${kindTok.text}". Expected text, number, tag, or anchor`,
        );
      }
      kind = kindTok.text as ValueKind;
    }

    if (specifier.type === 'metadata') {
      if (kind !== null) {
        throw new SearchSyntaxError(
          `"${specifier.name}" is file metadata, not a tag; "?kind" does not apply`,
        );
      }
      if (filters.length === 0) {
        throw new SearchSyntaxError(
          `"${specifier.name}" needs a filter, such as ${specifier.name}:<value>`,
        );
      }
      if (filters.length > 1) {
        throw new SearchSyntaxError(`"${specifier.name}" takes a single filter`);
      }
      return { type: 'selector', specifier, filters, kind };
    }

    if (filters.length <= 1) return { type: 'selector', specifier, filters, kind };

    //Chained `:` splits into pairs: `a:b:c` is `a:b AND b:c`. Intermediate parts are tags.
    const terms: QueryExpr[] = [];
    let currentSpecifier = specifier;
    for (const filter of filters.slice(0, -1)) {
      if (filter.type !== 'value' || filter.quoted || filter.tagOnly || filter.substring) {
        throw new SearchSyntaxError(
          'Only plain tag names can be chained with ":" (a:b:c is a:b and b:c)',
        );
      }
      terms.push({ type: 'selector', specifier: currentSpecifier, filters: [filter], kind: null });
      currentSpecifier = { type: 'path', segments: filter.text.split('/') };
    }
    terms.push({
      type: 'selector',
      specifier: currentSpecifier,
      filters: [filters[filters.length - 1]!],
      kind,
    });
    return { type: 'and', children: terms };
  }
}

function parseSpecifier(tok: WordToken): Specifier {
  if (tok.text === '') throw new SearchSyntaxError('Empty selector');
  if (!tok.quoted) {
    if (tok.text === '*') return { type: 'any' };
    if (METADATA_FIELDS.has(tok.text)) {
      return { type: 'metadata', name: tok.text as MetadataField };
    }
    const segments = tok.text.split('/');
    if (segments.some((s) => s === ''))
      throw new SearchSyntaxError(`Malformed tag path "${tok.text}"`);
    return { type: 'path', segments };
  }
  if (tok.text === '*') throw new SearchSyntaxError('"*" is reserved and is not a tag name');
  return { type: 'path', segments: [tok.text] };
}

function parseFilter(tok: WordToken): ValueFilter {
  if (!tok.quoted) {
    if (tok.text === '*') return { type: 'any' };
    if (tok.text.startsWith('#')) {
      const text = tok.text.slice(1);
      if (text === '') throw new SearchSyntaxError('Expected a tag name after "#"');
      return { type: 'value', text, quoted: false, tagOnly: true, substring: false };
    }
    const compare = /^([<>]=?|=)(.+)$/.exec(tok.text);
    if (compare) {
      return { type: 'compare', op: compare[1] as CompareOp, operand: compare[2]! };
    }
  }
  if (tok.text === '') throw new SearchSyntaxError('Empty value');
  return { type: 'value', text: tok.text, quoted: tok.quoted, tagOnly: false, substring: false };
}

/** Parses a query string into an AST plus commands (see docs/tags.md "Queries" and "Search"). */
export function parseQuery(query: string): ParsedQuery {
  return new Parser(tokenize(query)).parse();
}

//SQL compilation. A set term compiles to a predicate over the outer `files` row; terms
//compose with AND/OR/NOT. Names are resolved against the library's aliases up front, so
//the SQL only ever mentions tag ids.

type SqlValue = string | number;
type Compiled = { sql: string; params: SqlValue[] };
type Ctx = { db: Db; libraryId: number };

function aliasTagIds(ctx: Ctx, name: string): number[] {
  return (
    ctx.db
      .prepare('SELECT tag_id FROM aliases WHERE library_id = ? AND text = ?')
      .all(ctx.libraryId, name) as { tag_id: number }[]
  ).map((r) => r.tag_id);
}

/** Resolves a path `a/b/c` to the tags named `c` with an ancestor named `b`, which in turn
 *  has an ancestor named `a` (transitive via the closure table, so exact depth is irrelevant). */
function resolveTagIds(ctx: Ctx, segments: string[]): number[] {
  let candidates = aliasTagIds(ctx, segments[segments.length - 1]!);
  for (let i = segments.length - 2; i >= 0 && candidates.length > 0; i--) {
    const parents = aliasTagIds(ctx, segments[i]!);
    if (parents.length === 0) return [];
    const p = inClause(parents);
    const c = inClause(candidates);
    candidates = (
      ctx.db
        .prepare(
          `SELECT descendant_id FROM tag_ancestors
           WHERE ancestor_id IN (${p.sql}) AND descendant_id IN (${c.sql})`,
        )
        .all(...p.params, ...c.params) as { descendant_id: number }[]
    ).map((r) => r.descendant_id);
  }
  return candidates;
}

/** The ids plus everything below them in the parent DAG (closure rows include the tag itself). */
function descendantIds(ctx: Ctx, tagIds: number[]): number[] {
  if (tagIds.length === 0) return [];
  const { sql, params } = inClause(tagIds);
  return (
    ctx.db
      .prepare(`SELECT descendant_id FROM tag_ancestors WHERE ancestor_id IN (${sql})`)
      .all(...params) as { descendant_id: number }[]
  ).map((r) => r.descendant_id);
}

/** Condition restricting a tag column (prefixed by the caller as `<alias>.tag_id`). */
function tagSetCondition(ctx: Ctx, specifier: Specifier): Compiled | null {
  if (specifier.type === 'any') {
    return { sql: 'IN (SELECT tag_id FROM tags WHERE library_id = ?)', params: [ctx.libraryId] };
  }
  if (specifier.type !== 'path') return null;
  const ids = descendantIds(ctx, resolveTagIds(ctx, specifier.segments));
  if (ids.length === 0) return null;
  const { sql, params } = inClause(ids);
  return { sql: `IN (${sql})`, params };
}

const NOTHING: Compiled = { sql: '0 = 1', params: [] };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

function parseNumber(text: string): number | null {
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

/** `cat:orange` tries every kind the value parses as (text, number, tag) and unions them;
 *  `cat:"x"` and `cat:~x` are text-only; `cat:#x` is tag-only; a `?kind` restricts the kinds further. */
function compileFilter(ctx: Ctx, filter: ValueFilter, kind: ValueKind | null): Compiled {
  const allowed = (k: ValueKind) => kind === null || kind === k;
  if (filter.type === 'any') return { sql: '1 = 1', params: [] };

  if (filter.type === 'compare') {
    if (!allowed('number')) return NOTHING;
    const num = parseNumber(filter.operand);
    if (num === null) {
      throw new SearchSyntaxError(`Comparison operand "${filter.operand}" must be a number`);
    }
    return {
      sql: `v.kind = 'number' AND EXISTS (SELECT 1 FROM file_tag_value_number p
            WHERE p.value_id = v.value_id AND p.num_value ${filter.op} ?)`,
      params: [num],
    };
  }

  const alts: Compiled[] = [];
  if (!filter.tagOnly && allowed('text')) {
    if (filter.substring) {
      alts.push({
        sql: `v.kind = 'text' AND EXISTS (SELECT 1 FROM file_tag_value_text p
              WHERE p.value_id = v.value_id AND p.text_value LIKE ? ESCAPE '\\')`,
        params: [`%${escapeLike(filter.text)}%`],
      });
    } else {
      alts.push({
        sql: `v.kind = 'text' AND EXISTS (SELECT 1 FROM file_tag_value_text p
              WHERE p.value_id = v.value_id AND p.text_value = ? COLLATE NOCASE)`,
        params: [filter.text],
      });
    }
  }
  if (!filter.tagOnly && !filter.quoted && !filter.substring && allowed('number')) {
    const num = parseNumber(filter.text);
    if (num !== null) {
      alts.push({
        sql: `v.kind = 'number' AND EXISTS (SELECT 1 FROM file_tag_value_number p
              WHERE p.value_id = v.value_id AND p.num_value = ?)`,
        params: [num],
      });
    }
  }
  if ((filter.tagOnly || (!filter.quoted && !filter.substring)) && allowed('tag')) {
    //The closure applies to ref_tag_id too: `author:creator` matches `Author:Person` when
    //Person is a child of Creator.
    const segments = filter.quoted ? [filter.text] : filter.text.split('/');
    const refIds = descendantIds(ctx, resolveTagIds(ctx, segments));
    if (refIds.length > 0) {
      const { sql, params } = inClause(refIds);
      alts.push({
        sql: `v.kind = 'tag' AND EXISTS (SELECT 1 FROM file_tag_value_tag p
              WHERE p.value_id = v.value_id AND p.ref_tag_id IN (${sql}))`,
        params,
      });
    }
  }
  if (alts.length === 0) return NOTHING;
  if (alts.length === 1) return alts[0]!;
  return {
    sql: `(${alts.map((a) => a.sql).join(' OR ')})`,
    params: alts.flatMap((a) => a.params),
  };
}

function compileTagSelector(ctx: Ctx, sel: Selector): Compiled {
  const tagSet = tagSetCondition(ctx, sel.specifier);
  if (tagSet === null) return NOTHING; //unknown tag name: matches nothing

  if (sel.filters.length === 0 && sel.kind === null) {
    //A bare term matches any instance; tags used as values are also applied to the file,
    //so reading file_tag_relationships alone is enough.
    return {
      sql: `EXISTS (SELECT 1 FROM file_tag_relationships ftr
            WHERE ftr.file_id = files.file_id AND ftr.tag_id ${tagSet.sql})`,
      params: tagSet.params,
    };
  }

  const conditions: Compiled[] = [tagSet];
  if (sel.kind !== null) conditions.push({ sql: 'v.kind = ?', params: [sel.kind] });
  for (const filter of sel.filters) conditions.push(compileFilter(ctx, filter, sel.kind));

  //The subquery does not refer to the outer `files` row, so SQLite computes the set of
  //matching file ids one time from the values, not one time for each file.
  const sql = conditions.map((c, i) => (i === 0 ? `v.tag_id ${c.sql}` : c.sql)).join(' AND ');
  return {
    sql: `files.file_id IN (SELECT v.file_id FROM file_tag_values v WHERE ${sql})`,
    params: conditions.flatMap((c) => c.params),
  };
}

const SIZE_MULTIPLIERS: Record<string, number> = {
  B: 1,
  K: 1024,
  KB: 1024,
  M: 1024 ** 2,
  MB: 1024 ** 2,
  G: 1024 ** 3,
  GB: 1024 ** 3,
  T: 1024 ** 4,
  TB: 1024 ** 4,
};

function parseSize(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|K|M|G|T)?$/i.exec(text.trim());
  if (!m) return null;
  const unit = (m[2] ?? 'B').toUpperCase();
  return Math.round(Number(m[1]) * SIZE_MULTIPLIERS[unit]!);
}

function parseTimestamp(text: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/** The comparison for a metadata filter: a plain value means equality. */
function metadataCompare(
  filter: ValueFilter,
  parse: (text: string) => number | null,
  what: string,
) {
  if (filter.type === 'any') throw new SearchSyntaxError(`"${what}" needs a value or a comparison`);
  if (filter.type === 'value' && filter.substring) {
    throw new SearchSyntaxError(`"~" does not apply to "${what}"`);
  }
  const operand = filter.type === 'compare' ? filter.operand : filter.text;
  const value = parse(operand);
  if (value === null) throw new SearchSyntaxError(`Invalid ${what} value "${operand}"`);
  return { op: filter.type === 'compare' ? filter.op : '=', value };
}

function locationCondition(ctx: Ctx, condSql: string, condParams: SqlValue[]): Compiled {
  return {
    sql: `EXISTS (SELECT 1 FROM locations l
          WHERE l.file_id = files.file_id AND l.library_id = ? AND ${condSql})`,
    params: [ctx.libraryId, ...condParams],
  };
}

function compileMetadataSelector(ctx: Ctx, name: MetadataField, filter: ValueFilter): Compiled {
  if (name === 'size') {
    const { op, value } = metadataCompare(filter, parseSize, 'size');
    return { sql: `files.size ${op} ?`, params: [value] };
  }
  if (name === 'created_at' || name === 'modified_at') {
    const { op, value } = metadataCompare(
      filter,
      parseTimestamp,
      `${name} (use an ISO date like 2024-06-01)`,
    );
    return locationCondition(ctx, `l.${name} ${op} ?`, [value]);
  }
  if (filter.type !== 'value' || filter.substring) {
    throw new SearchSyntaxError(
      `"${name}" needs a value, such as ${name}:${name === 'type' ? 'image' : 'png'}`,
    );
  }
  const text =
    name === 'extension'
      ? filter.text.replace(/^\.+/, '').toLowerCase()
      : filter.text.toLowerCase();
  return locationCondition(ctx, `l.${name} = ?`, [text]);
}

function compileExpr(ctx: Ctx, expr: QueryExpr): Compiled {
  switch (expr.type) {
    case 'and':
    case 'or': {
      const parts = expr.children.map((c) => compileExpr(ctx, c));
      return {
        sql: `(${parts.map((p) => p.sql).join(expr.type === 'and' ? ' AND ' : ' OR ')})`,
        params: parts.flatMap((p) => p.params),
      };
    }
    case 'not': {
      const child = compileExpr(ctx, expr.child);
      return { sql: `NOT (${child.sql})`, params: child.params };
    }
    case 'selector':
      if (expr.specifier.type === 'metadata') {
        return compileMetadataSelector(ctx, expr.specifier.name, expr.filters[0]!);
      }
      return compileTagSelector(ctx, expr);
  }
}

export type SearchOptions = {
  limit?: number;
  offset?: number;
  /** Set to false to skip the count of all matches; `total` is then null. */
  count?: boolean;
};
export type SearchResult = {
  /** Number of matching files, ignoring limit and offset. Null when `count` is false. */
  total: number | null;
  fileIds: number[];
};

/** Runs `query` (the docs/tags.md search language) and returns the ids of the files that match
 *  and have a location in `libraryId`, one page at a time. Unknown tag names match nothing;
 *  invalid queries throw SearchSyntaxError. */
export function search(
  db: Db,
  query: string,
  libraryId: number,
  { limit, offset, count = true }: SearchOptions = {},
): SearchResult {
  const parsed = parseQuery(query);
  if (parsed.groupBys.length > 0) {
    throw new SearchSyntaxError(
      'group_by is not supported yet; search returns a flat list of file ids',
    );
  }

  const ctx: Ctx = { db, libraryId };
  const whereParts = [
    'EXISTS (SELECT 1 FROM locations vl WHERE vl.file_id = files.file_id AND vl.library_id = ?)',
  ];
  const params: SqlValue[] = [libraryId];
  if (parsed.expr !== null) {
    const compiled = compileExpr(ctx, parsed.expr);
    whereParts.push(compiled.sql);
    params.push(...compiled.params);
  }

  const orderBy: string[] = [];
  const orderParams: SqlValue[] = [];
  for (const sort of parsed.sorts) {
    const dir = sort.descending ? 'DESC' : 'ASC';
    if (sort.field === 'size') {
      orderBy.push(`files.size ${dir}`);
      continue;
    }
    const key = `(SELECT MIN(sl.${sort.field}) FROM locations sl
      WHERE sl.file_id = files.file_id AND sl.library_id = ?)`;
    orderBy.push(`${key} IS NULL, ${key} ${dir}`); //locations without a recorded time sort last
    orderParams.push(libraryId, libraryId);
  }

  orderBy.push('files.file_id'); //stable tiebreak, so pages do not overlap

  const where = whereParts.join(' AND ');
  const total = count
    ? (
        db.prepare(`SELECT COUNT(*) AS total FROM files WHERE ${where}`).get(...params) as {
          total: number;
        }
      ).total
    : null;

  const pageParams: SqlValue[] = [];
  let page = '';
  if (limit !== undefined || offset !== undefined) {
    page = ' LIMIT ? OFFSET ?';
    pageParams.push(limit ?? -1, offset ?? 0); //LIMIT -1 means no limit in SQLite
  }
  const sql = `SELECT files.file_id FROM files
    WHERE ${where} ORDER BY ${orderBy.join(', ')}${page}`;
  const rows = db.prepare(sql).all(...params, ...orderParams, ...pageParams) as {
    file_id: number;
  }[];
  return { total, fileIds: rows.map((r) => r.file_id) };
}

//Autocomplete. A separate, lenient tokenizer keeps character positions and reads an open
//quote as a partial quoted word, so a half-typed query never throws. parseQuery keeps the
//strict tokenizer.

export type CompletionKind = 'tag' | 'metadata' | 'command' | 'keyword' | 'valueKind';

export type Completion = {
  /** Text to put in place of `partial.slice(from, to)`, already quoted when needed. */
  text: string;
  kind: CompletionKind;
  tagId?: number;
  fileCount?: number;
  /** Primary alias of the primary parent (else of any parent), to tell same-named tags apart. */
  parent?: string | null;
  /** The tag's primary alias, set when the match came through a secondary alias. */
  primary?: string;
};

export type AutocompleteResult = { from: number; to: number; completions: Completion[] };

type PosToken = { t: Token['t']; start: number; end: number; text: string; quoted: boolean };

function tokenizeLenient(input: string): PosToken[] {
  const tokens: PosToken[] = [];
  const isBoundary = (c: string) => /\s/.test(c) || '():"?~'.includes(c);
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    const start = i;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ':' || ch === '?' || ch === '~') {
      const t =
        ch === '('
          ? 'lparen'
          : ch === ')'
            ? 'rparen'
            : ch === ':'
              ? 'colon'
              : ch === '?'
                ? 'question'
                : 'tilde';
      i++;
      tokens.push({ t, start, end: i, text: ch, quoted: false });
      continue;
    }
    let text = '';
    if (ch === '"') {
      i++;
      while (i < input.length) {
        const c = input[i]!;
        if (c === '\\' && i + 1 < input.length) {
          text += input[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
        text += c;
      }
      tokens.push({ t: 'word', start, end: i, text, quoted: true });
      continue;
    }
    while (i < input.length && !isBoundary(input[i]!)) {
      text += input[i];
      i++;
    }
    tokens.push({ t: 'word', start, end: i, text, quoted: false });
  }
  return tokens;
}

const KEYWORDS = ['and', 'or', 'not'];

/** Quotes `text` when the tokenizer would not read it back as the same single word.
 *  A specifier is also quoted when it holds `/` (it would read as a path) or is a keyword. */
function quoteWord(text: string, asSpecifier: boolean): string {
  const needsQuotes =
    text === '' ||
    /[\s():?~"]/.test(text) ||
    (asSpecifier && (text.includes('/') || KEYWORDS.includes(text.toLowerCase())));
  return needsQuotes ? `"${text.replace(/[\\"]/g, '\\$&')}"` : text;
}

//Characters that cannot appear in an unquoted path segment (a segment cannot be quoted).
const SEGMENT_UNSAFE_GLOB = '*[ \t\r\n():?~"/]*';

type TagRow = {
  tag_id: number;
  text: string;
  file_count: number;
  parent: string | null;
  primary_alias: string | null;
};

/** Tags with an alias that starts with `prefix` (case-insensitive), one row per tag (its
 *  primary alias when that matches), most used first. With `under`, only proper descendants
 *  of those tags, through aliases that can be written as an unquoted path segment. */
function matchingTags(ctx: Ctx, prefix: string, limit: number, under: number[] | null): TagRow[] {
  //The first parameter binds the outer SELECT's primary-alias subquery.
  const params: SqlValue[] = [ctx.libraryId, ctx.libraryId, `${escapeLike(prefix)}%`];
  let restrict = '';
  if (under !== null) {
    const { sql, params: underParams } = inClause(under);
    restrict = ` AND a.tag_id IN (SELECT descendant_id FROM tag_ancestors
      WHERE ancestor_id IN (${sql}) AND descendant_id <> ancestor_id)
      AND a.text NOT GLOB ?`;
    params.push(...underParams, SEGMENT_UNSAFE_GLOB);
  }
  params.push(limit);
  return ctx.db
    .prepare(
      `SELECT r.tag_id, r.text, r.file_count,
         (SELECT pa.text FROM tag_tag_values v
          JOIN tag_tag_value_parent pp ON pp.value_id = v.value_id
          JOIN aliases pa ON pa.tag_id = v.tag_id AND pa.is_primary = 1
          WHERE v.subject_tag_id = r.tag_id AND v.kind = 'parent'
          ORDER BY pp.is_primary DESC, v.value_id LIMIT 1) AS parent,
         (SELECT ma.text FROM aliases ma
          WHERE ma.tag_id = r.tag_id AND ma.library_id = ? AND ma.is_primary = 1) AS primary_alias
       FROM (
         SELECT a.tag_id, a.text, t.file_count,
           ROW_NUMBER() OVER (PARTITION BY a.tag_id ORDER BY a.is_primary DESC, a.text) AS rn
         FROM aliases a JOIN tags t ON t.tag_id = a.tag_id
         WHERE a.library_id = ? AND t.library_id = a.library_id
           AND a.text LIKE ? ESCAPE '\\'${restrict}
       ) r
       WHERE r.rn = 1
       ORDER BY r.file_count DESC, r.text, r.tag_id
       LIMIT ?`,
    )
    .all(...params) as TagRow[];
}

const tagCompletion = (row: TagRow, text: string): Completion => ({
  text,
  kind: 'tag',
  tagId: row.tag_id,
  fileCount: row.file_count,
  parent: row.parent,
  ...(row.primary_alias !== null && row.primary_alias !== row.text
    ? { primary: row.primary_alias }
    : {}),
});

/** Completes a tag word that starts at `start`. An unquoted word with `/` is a path: only
 *  its last segment is completed, among the descendants of the earlier segments. */
function completeTagWord(
  ctx: Ctx,
  word: { text: string; quoted: boolean },
  start: number,
  limit: number,
  asSpecifier: boolean,
): { from: number; completions: Completion[] } {
  const cut = word.quoted ? -1 : word.text.lastIndexOf('/');
  if (cut >= 0) {
    const earlier = word.text.slice(0, cut).split('/');
    const parents = earlier.some((s) => s === '') ? [] : resolveTagIds(ctx, earlier);
    const rows =
      parents.length === 0 ? [] : matchingTags(ctx, word.text.slice(cut + 1), limit, parents);
    return { from: start + cut + 1, completions: rows.map((r) => tagCompletion(r, r.text)) };
  }
  const rows = matchingTags(ctx, word.text, limit, null);
  return {
    from: start,
    completions: rows.map((r) => tagCompletion(r, quoteWord(r.text, asSpecifier))),
  };
}

function locationValueCompletions(
  ctx: Ctx,
  column: 'type' | 'extension',
  prefix: string,
  limit: number,
): Completion[] {
  const rows = ctx.db
    .prepare(
      `SELECT DISTINCT ${column} AS value FROM locations
       WHERE library_id = ? AND ${column} IS NOT NULL AND ${column} LIKE ? ESCAPE '\\'
       ORDER BY ${column} LIMIT ?`,
    )
    .all(ctx.libraryId, `${escapeLike(prefix)}%`, limit) as { value: string }[];
  return rows.map((r): Completion => ({ text: quoteWord(r.value, false), kind: 'keyword' }));
}

/** Completes the last token of `partial`, which must end at the end of the string. The
 *  context comes from the token before it: `?` (value kind), `:` (value, sort field, or
 *  metadata value), or anything else (specifier: tag, metadata field, command, keyword). */
export function autocomplete(
  db: Db,
  partial: string,
  libraryId: number,
  limit = 10,
): AutocompleteResult {
  const ctx: Ctx = { db, libraryId };
  const to = partial.length;
  const tokens = tokenizeLenient(partial);
  let word = { text: '', quoted: false };
  let from = to;
  const lastToken = tokens[tokens.length - 1];
  if (lastToken?.t === 'word' && lastToken.end === to) {
    word = lastToken;
    from = lastToken.start;
    tokens.pop();
  }
  const before = tokens[tokens.length - 1];
  const lower = word.text.toLowerCase();
  const done = (completions: Completion[], start = from): AutocompleteResult => ({
    from: start,
    to,
    completions: completions.slice(0, Math.max(0, limit)),
  });

  if (before?.t === 'question') {
    return done(
      [...VALUE_KINDS]
        .filter((k) => k.startsWith(lower))
        .map((k): Completion => ({ text: k, kind: 'valueKind' })),
    );
  }

  if (before?.t === 'tilde') return done([]);

  if (before?.t === 'colon') {
    //The word before the colon is a command or metadata name only when it starts a term.
    const head = tokens[tokens.length - 2];
    const name =
      head?.t === 'word' && !head.quoted && tokens[tokens.length - 3]?.t !== 'colon'
        ? head.text
        : null;
    if (name?.toLowerCase() === 'sort') {
      const fields = [...SORT_FIELDS, ...[...SORT_FIELDS].map((f) => `-${f}`)];
      return done(
        fields
          .filter((f) => f.startsWith(lower))
          .map((f): Completion => ({ text: f, kind: 'keyword' })),
      );
    }
    if (name?.toLowerCase() === 'group_by') return done([]);
    if (name === 'type') return done(locationValueCompletions(ctx, 'type', lower, limit));
    if (name === 'extension') {
      return done(locationValueCompletions(ctx, 'extension', lower.replace(/^\.+/, ''), limit));
    }
    if (name !== null && METADATA_FIELDS.has(name)) return done([]);

    if (!word.quoted && (word.text === '*' || /^[<>=]/.test(word.text))) return done([]);
    if (!word.quoted && word.text.startsWith('#')) {
      const { from: start, completions } = completeTagWord(
        ctx,
        { text: word.text.slice(1), quoted: false },
        from + 1,
        limit,
        false,
      );
      return done(completions, start);
    }
    const { from: start, completions } = completeTagWord(ctx, word, from, limit, false);
    return done(completions, start);
  }

  const tags = completeTagWord(ctx, word, from, limit, true);
  if (word.quoted || word.text.includes('/')) return done(tags.completions, tags.from);
  const builtins: Completion[] = [
    ...[...METADATA_FIELDS]
      .filter((f) => f.startsWith(lower))
      .map((f): Completion => ({ text: f, kind: 'metadata' })),
    ...[...COMMAND_NAMES]
      .filter((c) => c.startsWith(lower))
      .map((c): Completion => ({ text: `${c}:`, kind: 'command' })),
    ...(lower === ''
      ? []
      : KEYWORDS.filter((k) => k.startsWith(lower)).map((k): Completion => ({
          text: k,
          kind: 'keyword',
        }))),
  ];
  //With nothing typed yet, tags come first; once there is a prefix, the few matching
  //built-in names come first so the tag list cannot push them out of the limit.
  return done(
    lower === '' ? [...tags.completions, ...builtins] : [...builtins, ...tags.completions],
  );
}
