import { removeTagFromStore, upsertTagDetail, upsertTags } from './tagStore.svelte';

let refreshInFlight: Promise<Response> | null = null;

/** POSTs to the refresh endpoint, rotating the session cookies, and resolves whether the
 *  session was renewed. Concurrent callers share one in-flight request: the server rotates the
 *  refresh token on each call, so a racing second refresh would fail with the old token. */
export async function refreshSession(fetchFn: typeof fetch = fetch): Promise<boolean> {
  refreshInFlight ??= fetchFn('/api/auth/refresh', { method: 'POST' }).finally(() => {
    refreshInFlight = null;
  });
  return (await refreshInFlight).ok;
}

/** Runs a request, and on a 401 refreshes the session and retries the request once. All
 *  request bodies in this module are JSON strings, so replaying the init is safe. */
async function fetchWithRefresh(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const send = () => (init === undefined ? fetchFn(url) : fetchFn(url, init));
  let res = await send();
  if (res.status === 401 && (await refreshSession(fetchFn))) {
    res = await send();
  }
  return res;
}

/** `version` and `uptime` are present only when the caller has a valid session. */
export interface HealthResponse {
  status: 'ok';
  version?: string;
  uptime?: number;
}

export async function fetchHealth(fetchFn: typeof fetch = fetch): Promise<HealthResponse> {
  const res = await fetchWithRefresh(fetchFn, '/api/health');
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return (await res.json()) as HealthResponse;
}

export async function login(
  username: string,
  password: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) throw new ApiError(`Login failed: ${res.status}`, res.status, null);
}

export async function redeem(
  code: string,
  username: string,
  password: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn('/api/invitation/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, username, password }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(body?.error ?? `Redeem failed: ${res.status}`, res.status, body);
  }
}

/** Ends this session on the server and clears the session cookies. */
export async function logout(fetchFn: typeof fetch = fetch): Promise<void> {
  await fetchFn('/api/auth/logout', { method: 'POST' });
}

export interface CurrentUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

export async function fetchCurrentUser(fetchFn: typeof fetch = fetch): Promise<CurrentUser> {
  return (await apiRequest<{ user: CurrentUser }>(fetchFn, 'fetch user', '/api/auth/me')).user;
}

/** Changes the caller's password. The server ends all other sessions of the caller. */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest(fetchFn, 'change password', '/api/auth/password', 'POST', {
    currentPassword,
    newPassword,
  });
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

/** The same rule as the server: at least 8 characters and at most 72 UTF-8 bytes. Returns
 *  an error message, or null when the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if ([...password].length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    return `Use at most ${PASSWORD_MAX_BYTES} bytes (fewer characters if they are not ASCII).`;
  }
  return null;
}

export interface UserSummary {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export async function fetchUsers(fetchFn: typeof fetch = fetch): Promise<UserSummary[]> {
  return (await apiRequest<{ users: UserSummary[] }>(fetchFn, 'fetch users', '/api/users')).users;
}

export async function removeUser(id: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await apiRequest(fetchFn, 'remove user', `/api/users/${encodeURIComponent(id)}`, 'DELETE');
}

export interface LibraryPermissions {
  canRead: boolean;
  canCreateTag: boolean;
  canTagFiles: boolean;
  canManageLibrary: boolean;
}

export interface LibrarySummary {
  library_id: number;
  name: string;
  /** Null unless the caller is an admin or manages the library. */
  root_path: string | null;
  role: string;
  permissions: LibraryPermissions;
}

export async function fetchLibraries(fetchFn: typeof fetch = fetch): Promise<LibrarySummary[]> {
  const res = await fetchWithRefresh(fetchFn, '/api/libraries');
  if (!res.ok) throw new Error(`Failed to fetch libraries: ${res.status}`);
  return ((await res.json()) as { libraries: LibrarySummary[] }).libraries;
}

export async function createLibrary(
  name: string,
  rootPath: string,
  fetchFn: typeof fetch = fetch,
): Promise<LibrarySummary> {
  const res = await fetchWithRefresh(fetchFn, '/api/libraries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, rootPath }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to create library: ${res.status}`);
  }
  return ((await res.json()) as { library: LibrarySummary }).library;
}

export type JobLifecycleStatus = 'queued' | 'running' | 'complete' | 'error' | 'halted';

export interface JobStatusData {
  state: 'running' | 'complete' | 'error' | 'halted';
  message?: string;
  [key: string]: unknown;
}

export interface JobSummary {
  id: string;
  type: string;
  status: JobLifecycleStatus;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  options: unknown;
  statusData: JobStatusData | null;
  /** True when the caller may halt and delete the job. */
  canManage: boolean;
}

export async function fetchJobs(fetchFn: typeof fetch = fetch): Promise<JobSummary[]> {
  const res = await fetchWithRefresh(fetchFn, '/api/jobs');
  if (!res.ok) throw new Error(`Failed to fetch jobs: ${res.status}`);
  return ((await res.json()) as { jobs: JobSummary[] }).jobs;
}

export async function fetchJob(id: string, fetchFn: typeof fetch = fetch): Promise<JobSummary> {
  const res = await fetchWithRefresh(fetchFn, `/api/jobs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch job: ${res.status}`);
  const body = (await res.json()) as { job?: JobSummary };
  if (!body.job) throw new Error('Unexpected response from job endpoint');
  return body.job;
}

export async function deleteLibrary(id: number, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchWithRefresh(fetchFn, `/api/libraries/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to delete library: ${res.status}`);
  }
}

export async function startJob(
  jobType: string,
  options: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchWithRefresh(fetchFn, '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobType, options }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to start job: ${res.status}`);
  }
  return ((await res.json()) as { id: string }).id;
}

export async function haltJob(id: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchWithRefresh(fetchFn, `/api/jobs/${encodeURIComponent(id)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`Failed to halt job: ${res.status}`);
}

export async function deleteJob(id: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchWithRefresh(fetchFn, `/api/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to delete job: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Library-scoped file, tag, and search API
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error?: string;
  opIndex?: number;
  fileId?: number;
}

/** Error from the library-scoped API wrappers. Holds the HTTP status and the parsed error body. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;
  /** Index of the failed op in a batch request, if the server sent it. */
  readonly opIndex?: number;
  /** File that caused a batch failure, if the server sent it. */
  readonly fileId?: number;

  constructor(message: string, status: number, body: ApiErrorBody | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    if (typeof body?.opIndex === 'number') this.opIndex = body.opIndex;
    if (typeof body?.fileId === 'number') this.fileId = body.fileId;
  }
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Sends a request and returns the parsed JSON body, or `undefined` for an empty response.
 * A GET without a body calls `fetchFn(url)` with no init. Throws `ApiError` on non-2xx.
 */
async function apiRequest<T>(
  fetchFn: typeof fetch,
  action: string,
  url: string,
  method: HttpMethod = 'GET',
  body?: unknown,
): Promise<T> {
  let init: RequestInit | undefined;
  if (body !== undefined) {
    init = {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  } else if (method !== 'GET') {
    init = { method };
  }
  const res = await fetchWithRefresh(fetchFn, url, init);

  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as ApiErrorBody | null;
    const message =
      typeof errBody?.error === 'string' ? errBody.error : `Failed to ${action}: ${res.status}`;
    throw new ApiError(message, res.status, errBody);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function libraryPath(libraryId: number, ...parts: (string | number)[]): string {
  return [
    `/api/libraries/${encodeURIComponent(libraryId)}`,
    ...parts.map((part) => encodeURIComponent(part)),
  ].join('/');
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export interface PageOptions {
  limit?: number;
  offset?: number;
}

// ---- Files ----------------------------------------------------------------

export interface FileSummary {
  fileId: number;
  name: string;
  path: string;
  type: string | null;
  extension: string | null;
  size: number;
  missing: boolean;
  locationCount: number;
}

export interface FileSearchResult {
  /** Number of matching files on all pages. Null when the search skipped the count. */
  total: number | null;
  files: FileSummary[];
}

export interface FileSearchOptions extends PageOptions {
  /** Set to false to skip the count of all matches, when the total is already known. */
  count?: boolean;
}

/** A root-relative path in a library. Named to avoid the DOM `Location` global.
 *  Timestamps are unix epoch milliseconds, or null until a scan records them. */
export interface FileLocation {
  location_id: number;
  file_id: number;
  library_id: number;
  path: string;
  last_seen: number;
  missing: number;
  previous_file_id: number | null;
  extension: string | null;
  type: string | null;
  created_at: number | null;
  modified_at: number | null;
}

export type FileValue =
  | { valueId: number; kind: 'text'; text: string }
  | { valueId: number; kind: 'number'; number: number }
  | { valueId: number; kind: 'tag'; refTagId: number }
  | {
      valueId: number;
      kind: 'anchor';
      tStart: number | null;
      tEnd: number | null;
      rx: number | null;
      ry: number | null;
      rw: number | null;
      rh: number | null;
    };

export interface FileInstance {
  tagId: number;
  name: string | null;
  values: FileValue[];
}

export interface FileDetail {
  file: { file_id: number; file_hash: string; size: number };
  locations: FileLocation[];
  instances: FileInstance[];
  tags?: Record<number, TagSummary>;
}

export interface AnchorInput {
  tStart?: number | null;
  tEnd?: number | null;
  rx?: number | null;
  ry?: number | null;
  rw?: number | null;
  rh?: number | null;
}

export type NewFileValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'tag'; refTagId: number }
  | { kind: 'anchor'; anchor: AnchorInput };

export type FileQueryInclude = 'locations' | 'instances';

export type QueriedFile = FileSummary & {
  locations?: FileLocation[];
  instances?: FileInstance[];
};

export interface FileQueryResult {
  files: QueriedFile[];
  notFound: number[];
  tags?: Record<number, TagSummary>;
}

export type BatchOp =
  | { op: 'tag'; tagId: number }
  | { op: 'untag'; tagId: number }
  | { op: 'addValue'; tagId: number; value: NewFileValue }
  | { op: 'clearValues'; tagId: number };

export type CompletionKind = 'tag' | 'metadata' | 'command' | 'keyword' | 'valueKind';

export interface Completion {
  text: string;
  kind: CompletionKind;
  tagId?: number;
  fileCount?: number;
  parent?: string | null;
  /** The tag's primary alias when the match came through a secondary alias. */
  primary?: string;
}

export interface AutocompleteResult {
  from: number;
  to: number;
  completions: Completion[];
}

export async function searchFiles(
  libraryId: number,
  query = '',
  options: FileSearchOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<FileSearchResult> {
  const url = withQuery(libraryPath(libraryId, 'files'), {
    q: query,
    limit: options.limit,
    offset: options.offset,
    count: options.count === false ? 0 : undefined,
  });
  return apiRequest<FileSearchResult>(fetchFn, 'search files', url);
}

export async function autocompleteQuery(
  libraryId: number,
  query: string,
  limit?: number,
  fetchFn: typeof fetch = fetch,
): Promise<AutocompleteResult> {
  const url = withQuery(libraryPath(libraryId, 'autocomplete'), { q: query, limit });
  return apiRequest<AutocompleteResult>(fetchFn, 'autocomplete query', url);
}

export async function fetchFile(
  libraryId: number,
  fileId: number,
  fetchFn: typeof fetch = fetch,
): Promise<FileDetail> {
  const res = await apiRequest<FileDetail>(
    fetchFn,
    'fetch file',
    libraryPath(libraryId, 'files', fileId),
  );
  upsertTags(res?.tags, libraryId);
  return res;
}

export async function queryFiles(
  libraryId: number,
  ids: number[],
  include?: FileQueryInclude[],
  fetchFn: typeof fetch = fetch,
): Promise<FileQueryResult> {
  const body = include && include.length > 0 ? { ids, include } : { ids };
  const res = await apiRequest<FileQueryResult>(
    fetchFn,
    'query files',
    libraryPath(libraryId, 'files', 'query'),
    'POST',
    body,
  );
  upsertTags(res?.tags, libraryId);
  return res;
}

export async function applyTag(
  libraryId: number,
  fileId: number,
  tagId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'apply tag',
    libraryPath(libraryId, 'files', fileId, 'tags', tagId),
    'PUT',
  );
}

export async function removeTag(
  libraryId: number,
  fileId: number,
  tagId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'remove tag',
    libraryPath(libraryId, 'files', fileId, 'tags', tagId),
    'DELETE',
  );
}

export async function addFileValue(
  libraryId: number,
  fileId: number,
  tagId: number,
  value: NewFileValue,
  fetchFn: typeof fetch = fetch,
): Promise<FileValue> {
  const res = await apiRequest<{ value: FileValue }>(
    fetchFn,
    'add value',
    libraryPath(libraryId, 'files', fileId, 'tags', tagId, 'values'),
    'POST',
    value,
  );
  return res.value;
}

export async function updateFileValue(
  libraryId: number,
  fileId: number,
  valueId: number,
  value: NewFileValue,
  fetchFn: typeof fetch = fetch,
): Promise<FileValue> {
  const res = await apiRequest<{ value: FileValue }>(
    fetchFn,
    'update value',
    libraryPath(libraryId, 'files', fileId, 'values', valueId),
    'PATCH',
    value,
  );
  return res.value;
}

export async function deleteFileValue(
  libraryId: number,
  fileId: number,
  valueId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'delete value',
    libraryPath(libraryId, 'files', fileId, 'values', valueId),
    'DELETE',
  );
}

/**
 * Applies `ops` to every file in `fileIds` as one transaction.
 * On failure throws `ApiError` with `opIndex` and `fileId` if the server sent them.
 */
export async function batchUpdateFiles(
  libraryId: number,
  fileIds: number[],
  ops: BatchOp[],
  fetchFn: typeof fetch = fetch,
): Promise<FileSummary[]> {
  if (fileIds.length === 0) return [];
  const res = await apiRequest<{ files: FileSummary[] }>(
    fetchFn,
    'update files',
    libraryPath(libraryId, 'files', 'batch'),
    'POST',
    { fileIds, ops },
  );
  return res.files;
}

// ---- Tags -----------------------------------------------------------------

export interface TagSummary {
  tagId: number;
  name: string;
  color: string | null;
  isCategory: boolean;
  fileCount: number;
  parentName: string | null;
}

export interface TagListResult {
  total: number;
  tags: TagSummary[];
}

export interface TagRow {
  tag_id: number;
  library_id: number;
  is_category: number;
  file_count: number;
  color: string | null;
  wiki_text?: string;
  created_at: string;
  updated_at: string;
}

export interface Alias {
  alias_id: number;
  tag_id: number;
  library_id: number;
  text: string;
  is_primary: number;
  is_shorthand: number;
}

export type TagValue =
  | { valueId: number; kind: 'text'; text: string }
  | { valueId: number; kind: 'number'; number: number }
  | { valueId: number; kind: 'tag'; refTagId: number }
  | { valueId: number; kind: 'parent'; primary: boolean }
  | { valueId: number; kind: 'component'; recursive: boolean; attributed: boolean };

export interface TagInstance {
  tagId: number;
  name: string | null;
  values: TagValue[];
}

export interface TagHierarchyItem {
  tagId: number;
  name: string | null;
  color: string | null;
}

export interface TagDetail {
  tag: TagRow;
  aliases: Alias[];
  instances: TagInstance[];
  parents?: TagHierarchyItem[];
  ancestors?: TagHierarchyItem[];
  children?: TagHierarchyItem[];
  descendants?: TagHierarchyItem[];
  tags?: Record<number, TagSummary>;
}

export interface CreateTagInput {
  alias: string;
  color?: string | null;
  isCategory?: boolean;
  parentId?: number;
  wikiText?: string;
}

export interface UpdateTagInput {
  color?: string | null;
  isCategory?: boolean;
  wikiText?: string;
}

export interface UpdateAliasInput {
  text?: string;
  primary?: boolean;
  shorthand?: boolean;
}

export interface ParentOptions {
  primary?: boolean;
}

export interface ComponentOptions {
  recursive?: boolean;
  attributed?: boolean;
}

export type NewTagValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'tag'; refTagId: number };

export type TagValueUpdate =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'tag'; refTagId: number }
  | { kind: 'parent'; primary: boolean }
  | { kind: 'component'; recursive: boolean; attributed: boolean };

export async function listTags(
  libraryId: number,
  query = '',
  options: PageOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<TagListResult> {
  const url = withQuery(libraryPath(libraryId, 'tags'), {
    q: query,
    limit: options.limit,
    offset: options.offset,
  });
  const res = await apiRequest<TagListResult>(fetchFn, 'list tags', url);
  upsertTags(res?.tags, libraryId);
  return res;
}

export interface TagGraphNode extends TagSummary {
  /** Alias texts other than the name. */
  aliases: string[];
}

/** The instance of `tagId` on `subjectTagId`. `valueCount` counts the values that are
 *  not `parent` or `component`. */
export interface TagGraphEdge {
  subjectTagId: number;
  tagId: number;
  parent: boolean;
  primary: boolean;
  component: boolean;
  valueCount: number;
}

export interface TagGraph {
  tags: TagGraphNode[];
  edges: TagGraphEdge[];
}

/** Every tag of the library and every tag-tag relationship between them. */
export async function fetchTagGraph(
  libraryId: number,
  fetchFn: typeof fetch = fetch,
): Promise<TagGraph> {
  const res = await apiRequest<TagGraph>(
    fetchFn,
    'fetch tag graph',
    libraryPath(libraryId, 'tag-graph'),
  );
  upsertTags(res?.tags, libraryId);
  return res;
}

export async function createTag(
  libraryId: number,
  input: CreateTagInput,
  fetchFn: typeof fetch = fetch,
): Promise<TagDetail> {
  const res = await apiRequest<{ tag: TagDetail }>(
    fetchFn,
    'create tag',
    libraryPath(libraryId, 'tags'),
    'POST',
    input,
  );
  upsertTagDetail(res?.tag, libraryId);
  return res.tag;
}

export async function fetchTag(
  libraryId: number,
  tagId: number,
  fetchFn: typeof fetch = fetch,
): Promise<TagDetail> {
  const res = await apiRequest<{ tag: TagDetail }>(
    fetchFn,
    'fetch tag',
    libraryPath(libraryId, 'tags', tagId),
  );
  upsertTagDetail(res?.tag, libraryId);
  return res.tag;
}

export async function updateTag(
  libraryId: number,
  tagId: number,
  input: UpdateTagInput,
  fetchFn: typeof fetch = fetch,
): Promise<TagDetail> {
  const res = await apiRequest<{ tag: TagDetail }>(
    fetchFn,
    'update tag',
    libraryPath(libraryId, 'tags', tagId),
    'PATCH',
    input,
  );
  upsertTagDetail(res?.tag, libraryId);
  return res.tag;
}

export async function deleteTag(
  libraryId: number,
  tagId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(fetchFn, 'delete tag', libraryPath(libraryId, 'tags', tagId), 'DELETE');
  removeTagFromStore(tagId);
}

export async function addAlias(
  libraryId: number,
  tagId: number,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<TagDetail> {
  const res = await apiRequest<{ tag: TagDetail }>(
    fetchFn,
    'add alias',
    libraryPath(libraryId, 'tags', tagId, 'aliases'),
    'POST',
    { text },
  );
  upsertTagDetail(res?.tag, libraryId);
  return res.tag;
}

export async function updateAlias(
  libraryId: number,
  tagId: number,
  aliasId: number,
  input: UpdateAliasInput,
  fetchFn: typeof fetch = fetch,
): Promise<TagDetail> {
  const res = await apiRequest<{ tag: TagDetail }>(
    fetchFn,
    'update alias',
    libraryPath(libraryId, 'tags', tagId, 'aliases', aliasId),
    'PATCH',
    input,
  );
  upsertTagDetail(res?.tag, libraryId);
  return res.tag;
}

export async function deleteAlias(
  libraryId: number,
  tagId: number,
  aliasId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'delete alias',
    libraryPath(libraryId, 'tags', tagId, 'aliases', aliasId),
    'DELETE',
  );
}

export async function setTagParent(
  libraryId: number,
  tagId: number,
  parentId: number,
  options: ParentOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'set parent',
    libraryPath(libraryId, 'tags', tagId, 'parents', parentId),
    'PUT',
    options,
  );
}

export async function removeTagParent(
  libraryId: number,
  tagId: number,
  parentId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'remove parent',
    libraryPath(libraryId, 'tags', tagId, 'parents', parentId),
    'DELETE',
  );
}

export async function setTagComponent(
  libraryId: number,
  tagId: number,
  componentId: number,
  options: ComponentOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'set component',
    libraryPath(libraryId, 'tags', tagId, 'components', componentId),
    'PUT',
    options,
  );
}

export async function removeTagComponent(
  libraryId: number,
  tagId: number,
  componentId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'remove component',
    libraryPath(libraryId, 'tags', tagId, 'components', componentId),
    'DELETE',
  );
}

export async function tagTag(
  libraryId: number,
  tagId: number,
  refTagId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'tag tag',
    libraryPath(libraryId, 'tags', tagId, 'tags', refTagId),
    'PUT',
  );
}

export async function untagTag(
  libraryId: number,
  tagId: number,
  refTagId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'untag tag',
    libraryPath(libraryId, 'tags', tagId, 'tags', refTagId),
    'DELETE',
  );
}

export async function addTagValue(
  libraryId: number,
  tagId: number,
  refTagId: number,
  value: NewTagValue,
  fetchFn: typeof fetch = fetch,
): Promise<TagValue> {
  const res = await apiRequest<{ value: TagValue }>(
    fetchFn,
    'add tag value',
    libraryPath(libraryId, 'tags', tagId, 'tags', refTagId, 'values'),
    'POST',
    value,
  );
  return res.value;
}

export async function updateTagValue(
  libraryId: number,
  tagId: number,
  valueId: number,
  value: TagValueUpdate,
  fetchFn: typeof fetch = fetch,
): Promise<TagValue> {
  const res = await apiRequest<{ value: TagValue }>(
    fetchFn,
    'update tag value',
    libraryPath(libraryId, 'tags', tagId, 'values', valueId),
    'PATCH',
    value,
  );
  return res.value;
}

export async function deleteTagValue(
  libraryId: number,
  tagId: number,
  valueId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await apiRequest<void>(
    fetchFn,
    'delete tag value',
    libraryPath(libraryId, 'tags', tagId, 'values', valueId),
    'DELETE',
  );
}

// ---- Previews --------------------------------------------------------------

export interface PreviewEntry {
  fileId: number;
  type: string;
  /** Content type of the preview bytes, for building data URLs. */
  mime: string;
  /** Base64-encoded preview bytes. */
  data: string;
}

/** Direct URL for the file's full content as a displayable image. The endpoint serves
 *  web-ready originals unchanged and converts other images to PNG; non-image content or an
 *  invisible file answers an error status, so callers only point this at image files.
 *  Used as an `img src` — the session cookie rides along, no store needed. */
export const fileContentUrl = (fileId: number) => `/api/files/${fileId}/content`;

/** Fetches previews for many files in one request. Files with no preview are left out of the
 *  result; ids not visible to the caller come back in `notFound`. */
export async function fetchPreviews(
  ids: number[],
  fetchFn: typeof fetch = fetch,
): Promise<{ previews: PreviewEntry[]; notFound: number[] }> {
  return apiRequest(fetchFn, 'fetch previews', '/api/previews', 'POST', { ids });
}

// ---- Invitations -----------------------------------------------------------

export type LibraryRoleName = 'owner' | 'editor' | 'viewer';

export type InvitationStatus = 'pending' | 'used' | 'revoked' | 'expired';

export interface InvitationLibraryGrant {
  libraryId: number;
  libraryName: string;
  role: LibraryRoleName;
}

export interface InvitationSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revoked: boolean;
  used: boolean;
  status: InvitationStatus;
  isAdmin: boolean;
  issuerId: string | null;
  issuerUsername: string | null;
  claimantId: string | null;
  claimantUsername: string | null;
  libraryRoles: InvitationLibraryGrant[];
}

export interface CreateInvitationInput {
  isAdmin?: boolean;
  expiresInSeconds?: number;
  libraryRoles?: Array<{
    libraryId: number;
    role: LibraryRoleName;
  }>;
}

export interface CreatedInvitation {
  code: string;
  invitation: InvitationSummary;
}

export async function fetchInvitations(
  fetchFn: typeof fetch = fetch,
): Promise<InvitationSummary[]> {
  const res = await apiRequest<{ invitations: InvitationSummary[] }>(
    fetchFn,
    'fetch invitations',
    '/api/invitations',
  );
  return res.invitations;
}

export async function createInvitation(
  input: CreateInvitationInput = {},
  fetchFn: typeof fetch = fetch,
): Promise<CreatedInvitation> {
  return apiRequest<CreatedInvitation>(
    fetchFn,
    'create invitation',
    '/api/invitations',
    'POST',
    input,
  );
}

export async function revokeInvitation(
  id: string,
  fetchFn: typeof fetch = fetch,
): Promise<InvitationSummary> {
  const res = await apiRequest<{ invitation: InvitationSummary }>(
    fetchFn,
    'revoke invitation',
    `/api/invitations/${encodeURIComponent(id)}/revoke`,
    'POST',
  );
  return res.invitation;
}
