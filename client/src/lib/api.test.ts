import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  addFileValue,
  applyTag,
  autocompleteQuery,
  batchUpdateFiles,
  createInvitation,
  createTag,
  deleteJob,
  deleteTag,
  fetchFile,
  fetchHealth,
  fetchInvitations,
  fetchJob,
  fetchJobs,
  fetchLibraries,
  haltJob,
  listTags,
  login,
  queryFiles,
  redeem,
  refreshSession,
  removeTag,
  revokeInvitation,
  searchFiles,
  setTagComponent,
  setTagParent,
  startJob,
  updateAlias,
  updateFileValue,
  updateTag,
  updateTagValue,
  deleteFileValue,
} from './api';

const mockFetch = (status: number, body: unknown) =>
  vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('fetchHealth', () => {
  it('returns parsed health payload', async () => {
    const payload = { status: 'ok', version: '1.2.3', uptime: 42 };
    const fetchFn = mockFetch(200, payload);

    await expect(fetchHealth(fetchFn)).resolves.toEqual(payload);
    expect(fetchFn).toHaveBeenCalledWith('/api/health');
  });

  it('throws on non-2xx response', async () => {
    await expect(fetchHealth(mockFetch(503, {}))).rejects.toThrow('503');
  });
});

describe('login', () => {
  it('submits credentials to the login endpoint', async () => {
    const fetchFn = mockFetch(200, null);

    await expect(login('alice', 'secret', fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'secret' }),
    });
  });

  it('throws on rejected credentials', async () => {
    await expect(login('alice', 'wrong', mockFetch(401, {}))).rejects.toThrow('401');
  });

  it('does not attempt a refresh on failed login', async () => {
    const fetchFn = mockFetch(401, {});
    await expect(login('alice', 'wrong', fetchFn)).rejects.toThrow('401');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('redeem', () => {
  it('submits the invitation code and new credentials to the redeem endpoint', async () => {
    const fetchFn = mockFetch(200, null);

    await expect(redeem('CODE123', 'alice', 'secret', fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith('/api/invitation/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'CODE123', username: 'alice', password: 'secret' }),
    });
  });

  it('throws on an invalid or expired code', async () => {
    await expect(redeem('BAD', 'alice', 'secret', mockFetch(401, {}))).rejects.toThrow('401');
  });
});

describe('fetchLibraries', () => {
  it('returns the libraries list', async () => {
    const libraries = [{ library_id: 7, name: 'Photos' }];
    const fetchFn = mockFetch(200, { libraries });

    await expect(fetchLibraries(fetchFn)).resolves.toEqual(libraries);
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries');
  });

  it('throws on non-2xx response', async () => {
    await expect(fetchLibraries(mockFetch(500, {}))).rejects.toThrow('500');
  });
});

describe('fetchJobs', () => {
  it('returns the jobs list', async () => {
    const jobs = [{ id: 'j1', type: 'library-scan' }];
    const fetchFn = mockFetch(200, { jobs });

    await expect(fetchJobs(fetchFn)).resolves.toEqual(jobs);
    expect(fetchFn).toHaveBeenCalledWith('/api/jobs');
  });

  it('throws on non-2xx response', async () => {
    await expect(fetchJobs(mockFetch(500, {}))).rejects.toThrow('500');
  });
});

describe('fetchJob', () => {
  it('fetches and escapes the id', async () => {
    const job = { id: 'a/b', type: 'library-scan' };
    const fetchFn = mockFetch(200, { job });

    await expect(fetchJob('a/b', fetchFn)).resolves.toEqual(job);
    expect(fetchFn).toHaveBeenCalledWith('/api/jobs/a%2Fb');
  });

  it('throws on non-2xx response', async () => {
    await expect(fetchJob('missing', mockFetch(404, {}))).rejects.toThrow('404');
  });
});

describe('startJob', () => {
  it('posts the type and options and returns the new id', async () => {
    const fetchFn = mockFetch(201, { id: 'new-id' });

    await expect(startJob('library-scan', { libraryId: 3 }, fetchFn)).resolves.toBe('new-id');
    expect(fetchFn).toHaveBeenCalledWith('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobType: 'library-scan', options: { libraryId: 3 } }),
    });
  });

  it('surfaces the server error message', async () => {
    await expect(startJob('nope', {}, mockFetch(400, { error: 'bad options' }))).rejects.toThrow(
      'bad options',
    );
  });
});

describe('haltJob', () => {
  it('PUTs to the job endpoint', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;

    await expect(haltJob('j1', fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith('/api/jobs/j1', { method: 'PUT' });
  });

  it('throws on non-2xx response', async () => {
    await expect(haltJob('j1', mockFetch(500, {}))).rejects.toThrow('500');
  });
});

describe('deleteJob', () => {
  it('DELETEs the job endpoint', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;

    await expect(deleteJob('j1', fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith('/api/jobs/j1', { method: 'DELETE' });
  });

  it('throws on non-2xx response', async () => {
    await expect(deleteJob('j1', mockFetch(404, {}))).rejects.toThrow('404');
  });
});

describe('session refresh', () => {
  const filesUrl = '/api/libraries/2/files';

  it('refreshSession POSTs to the refresh endpoint and resolves whether it succeeded', async () => {
    const okFetch = mockFetch(200, null);
    await expect(refreshSession(okFetch)).resolves.toBe(true);
    expect(okFetch).toHaveBeenCalledWith('/api/auth/refresh', { method: 'POST' });

    await expect(refreshSession(mockFetch(401, {}))).resolves.toBe(false);
  });

  it('refreshes the session and retries the request on a 401', async () => {
    const payload = { total: 1, files: [{ fileId: 3 }] };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Invalid JWT' }), { status: 401 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));

    await expect(searchFiles(2, '', {}, fetchFn as unknown as typeof fetch)).resolves.toEqual(
      payload,
    );
    expect(fetchFn).toHaveBeenNthCalledWith(1, filesUrl);
    expect(fetchFn).toHaveBeenNthCalledWith(2, '/api/auth/refresh', { method: 'POST' });
    expect(fetchFn).toHaveBeenNthCalledWith(3, filesUrl);
  });

  it('surfaces the 401 when the refresh fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Invalid JWT' }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Invalid refresh token' }), { status: 401 }),
      );

    await expect(searchFiles(2, '', {}, fetchFn as unknown as typeof fetch)).rejects.toThrow(
      'Invalid JWT',
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('shares one refresh across concurrent requests', async () => {
    let filesCalls = 0;
    const fetchFn = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/refresh') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      filesCalls += 1;
      const fresh =
        filesCalls > 2
          ? new Response(JSON.stringify({ total: 0, files: [] }), { status: 200 })
          : new Response(JSON.stringify({}), { status: 401 });
      return Promise.resolve(fresh);
    }) as unknown as typeof fetch;

    await Promise.all([searchFiles(2, '', {}, fetchFn), searchFiles(2, '', {}, fetchFn)]);
    const refreshCalls = vi
      .mocked(fetchFn)
      .mock.calls.filter(([url]) => String(url) === '/api/auth/refresh');
    expect(refreshCalls).toHaveLength(1);
  });
});

const noContent = () =>
  vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;

const jsonInit = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('searchFiles', () => {
  it('GETs the files endpoint with query params', async () => {
    const payload = { total: 1, files: [{ fileId: 3, name: 'a.jpg' }] };
    const fetchFn = mockFetch(200, payload);

    await expect(searchFiles(7, 'cat & dog', { limit: 50, offset: 100 }, fetchFn)).resolves.toEqual(
      payload,
    );
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/7/files?q=cat+%26+dog&limit=50&offset=100',
    );
  });

  it('sends count=0 to skip the count', async () => {
    const fetchFn = mockFetch(200, { total: null, files: [] });

    await searchFiles(7, 'cat', { offset: 24, count: false }, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries/7/files?q=cat&offset=24&count=0');
  });

  it('omits empty params', async () => {
    const fetchFn = mockFetch(200, { total: 0, files: [] });

    await searchFiles(7, '', {}, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries/7/files');
  });

  it('surfaces the server error message as an ApiError', async () => {
    const err = await searchFiles(7, 'tag:(', {}, mockFetch(400, { error: 'Parse error' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Parse error');
    expect((err as ApiError).status).toBe(400);
  });

  it('falls back to a status message when the body has no error', async () => {
    await expect(searchFiles(7, 'x', {}, mockFetch(500, {}))).rejects.toThrow(
      'Failed to search files: 500',
    );
  });
});

describe('autocompleteQuery', () => {
  it('GETs the autocomplete endpoint', async () => {
    const payload = { from: 0, to: 2, completions: [{ text: 'cat', kind: 'tag', tagId: 1 }] };
    const fetchFn = mockFetch(200, payload);

    await expect(autocompleteQuery(2, 'ca', 10, fetchFn)).resolves.toEqual(payload);
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries/2/autocomplete?q=ca&limit=10');
  });
});

describe('fetchFile', () => {
  it('GETs the file detail endpoint', async () => {
    const payload = { file: { file_id: 4, file_hash: 'h', size: 1 }, locations: [], instances: [] };
    const fetchFn = mockFetch(200, payload);

    await expect(fetchFile(2, 4, fetchFn)).resolves.toEqual(payload);
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries/2/files/4');
  });
});

describe('queryFiles', () => {
  it('POSTs ids and include list', async () => {
    const payload = { files: [{ fileId: 1 }], notFound: [9] };
    const fetchFn = mockFetch(200, payload);

    await expect(queryFiles(2, [1, 9], ['instances'], fetchFn)).resolves.toEqual(payload);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/2/files/query',
      jsonInit('POST', { ids: [1, 9], include: ['instances'] }),
    );
  });

  it('omits include when not given', async () => {
    const fetchFn = mockFetch(200, { files: [], notFound: [] });

    await queryFiles(2, [1], undefined, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/2/files/query',
      jsonInit('POST', { ids: [1] }),
    );
  });
});

describe('file tag calls', () => {
  it('applyTag PUTs with no body and resolves on 204', async () => {
    const fetchFn = noContent();

    await expect(applyTag(2, 4, 8, fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries/2/files/4/tags/8', { method: 'PUT' });
  });

  it('removeTag DELETEs the instance', async () => {
    const fetchFn = noContent();

    await expect(removeTag(2, 4, 8, fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries/2/files/4/tags/8', { method: 'DELETE' });
  });

  it('addFileValue POSTs the value and returns it', async () => {
    const value = { valueId: 11, kind: 'number', number: 5 };
    const fetchFn = mockFetch(201, { value });

    await expect(addFileValue(2, 4, 8, { kind: 'number', number: 5 }, fetchFn)).resolves.toEqual(
      value,
    );
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/2/files/4/tags/8/values',
      jsonInit('POST', { kind: 'number', number: 5 }),
    );
  });

  it('updateFileValue PATCHes the value and returns it', async () => {
    const value = { valueId: 11, kind: 'text', text: 'revised' };
    const fetchFn = mockFetch(200, { value });

    await expect(
      updateFileValue(2, 4, 11, { kind: 'text', text: 'revised' }, fetchFn),
    ).resolves.toEqual(value);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/2/files/4/values/11',
      jsonInit('PATCH', { kind: 'text', text: 'revised' }),
    );
  });

  it('deleteFileValue DELETEs the value and resolves on 204', async () => {
    const fetchFn = noContent();

    await expect(deleteFileValue(2, 4, 11, fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries/2/files/4/values/11', {
      method: 'DELETE',
    });
  });
});

describe('batchUpdateFiles', () => {
  const ops = [
    { op: 'tag' as const, tagId: 1 },
    { op: 'addValue' as const, tagId: 1, value: { kind: 'text' as const, text: 'x' } },
  ];

  it('POSTs file ids and ops and returns the files', async () => {
    const files = [{ fileId: 1 }, { fileId: 2 }];
    const fetchFn = mockFetch(200, { files });

    await expect(batchUpdateFiles(2, [1, 2], ops, fetchFn)).resolves.toEqual(files);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/2/files/batch',
      jsonInit('POST', { fileIds: [1, 2], ops }),
    );
  });

  it('sends no request and resolves empty for an empty file list', async () => {
    const fetchFn = mockFetch(200, { files: [] });

    await expect(batchUpdateFiles(2, [], ops, fetchFn)).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws an ApiError with opIndex and fileId', async () => {
    const fetchFn = mockFetch(400, { error: 'Tag not found', opIndex: 1, fileId: 2 });
    const err = await batchUpdateFiles(2, [1, 2], ops, fetchFn).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    const apiErr = err as ApiError;
    expect(apiErr.message).toBe('Tag not found');
    expect(apiErr.status).toBe(400);
    expect(apiErr.opIndex).toBe(1);
    expect(apiErr.fileId).toBe(2);
    expect(apiErr.body).toEqual({ error: 'Tag not found', opIndex: 1, fileId: 2 });
  });

  it('leaves opIndex undefined when the server does not send it', async () => {
    const err = await batchUpdateFiles(2, [1], ops, mockFetch(403, { error: 'Forbidden' })).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).opIndex).toBeUndefined();
    expect((err as ApiError).fileId).toBeUndefined();
  });
});

describe('tag calls', () => {
  const detail = { tag: { tag_id: 5 }, aliases: [], instances: [] };

  it('listTags GETs with params', async () => {
    const fetchFn = mockFetch(200, { total: 0, tags: [] });

    await listTags(2, 'ca', { limit: 5 }, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries/2/tags?q=ca&limit=5');
  });

  it('createTag POSTs the input and returns the tag detail', async () => {
    const fetchFn = mockFetch(201, { tag: detail });
    const input = { alias: 'cat', color: '#ff0000', parentId: 3 };

    await expect(createTag(2, input, fetchFn)).resolves.toEqual(detail);
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries/2/tags', jsonInit('POST', input));
  });

  it('createTag surfaces the server error', async () => {
    await expect(
      createTag(2, { alias: 'cat' }, mockFetch(409, { error: 'Alias already exists' })),
    ).rejects.toThrow('Alias already exists');
  });

  it('updateAlias PATCHes the alias and returns the tag detail', async () => {
    const fetchFn = mockFetch(200, { tag: detail });

    await expect(updateAlias(2, 5, 12, { primary: true }, fetchFn)).resolves.toEqual(detail);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/2/tags/5/aliases/12',
      jsonInit('PATCH', { primary: true }),
    );
  });

  it('setTagParent PUTs the options and resolves on 204', async () => {
    const fetchFn = noContent();

    await expect(setTagParent(2, 5, 6, { primary: true }, fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/2/tags/5/parents/6',
      jsonInit('PUT', { primary: true }),
    );
  });

  it('setTagComponent PUTs the flags', async () => {
    const fetchFn = noContent();

    await setTagComponent(2, 5, 6, { recursive: true, attributed: false }, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/2/tags/5/components/6',
      jsonInit('PUT', { recursive: true, attributed: false }),
    );
  });

  it('deleteTag DELETEs the tag', async () => {
    const fetchFn = noContent();

    await expect(deleteTag(2, 5, fetchFn)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith('/api/libraries/2/tags/5', { method: 'DELETE' });
  });

  it('deleteTag falls back to a status message', async () => {
    await expect(deleteTag(2, 5, mockFetch(404, {}))).rejects.toThrow('Failed to delete tag: 404');
  });

  it('updateTagValue PATCHes the value and returns it', async () => {
    const value = { valueId: 15, kind: 'text', text: 'updated' };
    const fetchFn = mockFetch(200, { value });

    await expect(
      updateTagValue(2, 5, 15, { kind: 'text', text: 'updated' }, fetchFn),
    ).resolves.toEqual(value);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/2/tags/5/values/15',
      jsonInit('PATCH', { kind: 'text', text: 'updated' }),
    );
  });

  it('updateTag PATCHes wikiText and returns the tag detail', async () => {
    const fetchFn = mockFetch(200, { tag: detail });

    await expect(updateTag(2, 5, { wikiText: '# Notes' }, fetchFn)).resolves.toEqual(detail);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/libraries/2/tags/5',
      jsonInit('PATCH', { wikiText: '# Notes' }),
    );
  });
});

describe('invitation calls', () => {
  const sampleInvitation = {
    id: 'inv-1',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    expiresAt: '2026-10-24T00:00:00.000Z',
    revoked: false,
    used: false,
    status: 'pending' as const,
    isAdmin: false,
    issuerId: 'u-1',
    issuerUsername: 'admin',
    claimantId: null,
    claimantUsername: null,
    libraryRoles: [{ libraryId: 1, libraryName: 'Photos', role: 'editor' as const }],
  };

  it('fetchInvitations GETs the invitations list', async () => {
    const fetchFn = mockFetch(200, { invitations: [sampleInvitation] });

    await expect(fetchInvitations(fetchFn)).resolves.toEqual([sampleInvitation]);
    expect(fetchFn).toHaveBeenCalledWith('/api/invitations');
  });

  it('createInvitation POSTs the payload and returns code and invitation', async () => {
    const created = { code: 'secret-code-123', invitation: sampleInvitation };
    const fetchFn = mockFetch(201, created);
    const input = {
      isAdmin: true,
      expiresInSeconds: 3600,
      libraryRoles: [{ libraryId: 1, role: 'editor' as const }],
    };

    await expect(createInvitation(input, fetchFn)).resolves.toEqual(created);
    expect(fetchFn).toHaveBeenCalledWith('/api/invitations', jsonInit('POST', input));
  });

  it('revokeInvitation POSTs to the revoke endpoint and returns updated invitation', async () => {
    const revoked = { ...sampleInvitation, revoked: true, status: 'revoked' as const };
    const fetchFn = mockFetch(200, { invitation: revoked });

    await expect(revokeInvitation('inv-1', fetchFn)).resolves.toEqual(revoked);
    expect(fetchFn).toHaveBeenCalledWith('/api/invitations/inv-1/revoke', { method: 'POST' });
  });
});
