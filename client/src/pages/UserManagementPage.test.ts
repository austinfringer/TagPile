import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvitationSummary, LibrarySummary } from '../lib/api';
import { currentPath, navigate } from '../lib/router.svelte';
import UserManagementPage from './UserManagementPage.svelte';

function makeLibrary(overrides: Partial<LibrarySummary> = {}): LibrarySummary {
  return {
    library_id: 1,
    name: 'Photos',
    root_path: '/data/photos',
    role: 'owner',
    permissions: { canRead: true, canCreateTag: true, canTagFiles: true, canManageLibrary: true },
    ...overrides,
  };
}

function makeInvitation(overrides: Partial<InvitationSummary> = {}): InvitationSummary {
  return {
    id: 'inv-1',
    createdAt: '2026-10-23T10:00:00.000Z',
    updatedAt: '2026-10-23T10:00:00.000Z',
    expiresAt: '2026-10-24T10:00:00.000Z',
    revoked: false,
    used: false,
    status: 'pending',
    isAdmin: false,
    issuerId: 'u-1',
    issuerUsername: 'admin',
    claimantId: null,
    claimantUsername: null,
    libraryRoles: [],
    ...overrides,
  };
}

function stubFetch(
  invitations: InvitationSummary[],
  libraries: LibrarySummary[] = [],
  options: { createError?: string; listError?: string } = {},
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url === '/api/invitations' && (!init?.method || init.method === 'GET')) {
      if (options.listError) {
        return new Response(JSON.stringify({ error: options.listError }), { status: 403 });
      }
      return new Response(JSON.stringify({ invitations }), { status: 200 });
    }

    if (url === '/api/invitations' && init?.method === 'POST') {
      if (options.createError) {
        return new Response(JSON.stringify({ error: options.createError }), { status: 400 });
      }
      const body = JSON.parse(String(init.body)) as {
        isAdmin?: boolean;
        expiresInSeconds?: number;
        libraryRoles?: { libraryId: number; role: 'owner' | 'editor' | 'viewer' }[];
      };
      const created = makeInvitation({
        id: `inv-${invitations.length + 1}`,
        isAdmin: Boolean(body.isAdmin),
        libraryRoles: (body.libraryRoles ?? []).map((g) => ({
          libraryId: g.libraryId,
          libraryName: libraries.find((l) => l.library_id === g.libraryId)?.name ?? 'Lib',
          role: g.role,
        })),
      });
      invitations.unshift(created);
      return new Response(
        JSON.stringify({ code: 'generated-invite-code-xyz', invitation: created }),
        { status: 201 },
      );
    }

    const revokeMatch = /^\/api\/invitations\/([^/]+)\/revoke$/.exec(url);
    if (revokeMatch && init?.method === 'POST') {
      const id = decodeURIComponent(revokeMatch[1]!);
      const target = invitations.find((i) => i.id === id);
      if (!target) {
        return new Response(JSON.stringify({ error: 'Invitation not found' }), { status: 404 });
      }
      target.revoked = true;
      target.status = 'revoked';
      return new Response(JSON.stringify({ invitation: target }), { status: 200 });
    }

    if (url === '/api/libraries') {
      return new Response(JSON.stringify({ libraries }), { status: 200 });
    }

    return new Response(JSON.stringify({}), { status: 404 });
  });
  return calls;
}

describe('UserManagementPage', () => {
  beforeEach(() => navigate('/settings/users'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders pending, used, and revoked invitations and shows the user created by used invitations', async () => {
    stubFetch([
      makeInvitation({
        id: 'inv-pending',
        status: 'pending',
        isAdmin: true,
        libraryRoles: [{ libraryId: 1, libraryName: 'Photos', role: 'editor' }],
      }),
      makeInvitation({
        id: 'inv-used',
        used: true,
        status: 'used',
        claimantId: 'u-bob',
        claimantUsername: 'bob',
      }),
      makeInvitation({
        id: 'inv-revoked',
        revoked: true,
        status: 'revoked',
      }),
    ]);

    render(UserManagementPage);

    expect(screen.getByRole('heading', { name: 'User management' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('1 pending')).toBeInTheDocument());
    expect(screen.getByText('3 total')).toBeInTheDocument();

    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Used')).toBeInTheDocument();
    expect(screen.getByText('Photos: editor')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText(/Created user:/)).toBeInTheDocument();

    // Only the single pending invitation should have a Revoke button.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });

  it('navigates back to /settings when the Settings breadcrumb is clicked', async () => {
    stubFetch([]);
    render(UserManagementPage);

    await fireEvent.click(screen.getByRole('button', { name: '← Settings' }));
    expect(currentPath()).toBe('/settings');
  });

  it('toggles the Invitations dropdown section open and closed', async () => {
    stubFetch([]);
    render(UserManagementPage);

    await waitFor(() => expect(screen.getByText(/No invitations yet/)).toBeInTheDocument());
    const toggle = screen.getByRole('button', { name: /Invitations/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/No invitations yet/)).not.toBeInTheDocument();

    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/No invitations yet/)).toBeInTheDocument();
  });

  it('revokes a pending invitation when Revoke is clicked', async () => {
    const calls = stubFetch([makeInvitation({ id: 'inv-42', status: 'pending' })]);
    render(UserManagementPage);

    const revokeBtn = await screen.findByRole('button', { name: 'Revoke' });
    await fireEvent.click(revokeBtn);

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/invitations/inv-42/revoke',
        init: { method: 'POST' },
      });
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('0 pending')).toBeInTheDocument();
  });

  it('creates a new invitation with global and per-library permissions and displays the code once', async () => {
    const calls = stubFetch(
      [],
      [
        makeLibrary({ library_id: 1, name: 'Photos', root_path: '/data/photos' }),
        makeLibrary({ library_id: 2, name: 'Docs', root_path: '/data/docs' }),
      ],
    );
    render(UserManagementPage);

    const photosSelect = await screen.findByLabelText('Role for Photos');
    await fireEvent.change(photosSelect, { target: { value: 'editor' } });
    await fireEvent.change(screen.getByLabelText('Global role'), { target: { value: 'admin' } });
    await fireEvent.change(screen.getByLabelText('Expires in'), { target: { value: '3600' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/invitations' && c.init?.method === 'POST');
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        isAdmin: true,
        expiresInSeconds: 3600,
        libraryRoles: [{ libraryId: 1, role: 'editor' }],
      });
    });

    await waitFor(() => expect(screen.getByText('generated-invite-code-xyz')).toBeInTheDocument());
    expect(screen.getByText('Photos: editor')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('generated-invite-code-xyz')).not.toBeInTheDocument();
  });

  it('lists users and removes one after the confirmation', async () => {
    let users = [
      { id: 'u-1', username: 'admin', isAdmin: true, createdAt: '2026-10-23T10:00:00.000Z' },
      { id: 'u-2', username: 'carol', isAdmin: false, createdAt: '2026-10-23T10:00:00.000Z' },
    ];
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method });
      if (url === '/api/users') return Response.json({ users });
      if (url === '/api/auth/me') return Response.json({ user: users[0] });
      if (url === '/api/users/u-2' && init?.method === 'DELETE') {
        users = users.filter((u) => u.id !== 'u-2');
        return new Response(null, { status: 204 });
      }
      if (url === '/api/invitations') return Response.json({ invitations: [] });
      return Response.json({ libraries: [] });
    });
    render(UserManagementPage);

    expect(await screen.findByText('carol')).toBeInTheDocument();
    // The caller cannot remove the caller's own account.
    await waitFor(() => expect(screen.getByText('You')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);

    await fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog');
    const digits = dialog.querySelector('.digits')!.textContent!;
    await fireEvent.input(screen.getByLabelText('Confirmation digits'), {
      target: { value: digits },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove user' }));

    await waitFor(() => expect(screen.queryByText('carol')).not.toBeInTheDocument());
    expect(calls).toContainEqual({ url: '/api/users/u-2', method: 'DELETE' });
  });

  it('surfaces errors when loading or creating invitations fails', async () => {
    stubFetch([], [], { createError: 'Invalid library role entry' });
    render(UserManagementPage);

    await waitFor(() => expect(screen.getByText(/No invitations yet/)).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));

    await waitFor(() => expect(screen.getByText('Invalid library role entry')).toBeInTheDocument());
  });
});
