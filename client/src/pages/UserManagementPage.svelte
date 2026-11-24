<script lang="ts">
  import Button from '../lib/Button.svelte';
  import ConfirmationModal from '../lib/ConfirmationModal.svelte';
  import Icon from '../lib/Icon.svelte';
  import Pill from '../lib/Pill.svelte';
  import {
    createInvitation,
    fetchCurrentUser,
    fetchInvitations,
    fetchLibraries,
    fetchUsers,
    removeUser,
    revokeInvitation,
    type InvitationStatus,
    type InvitationSummary,
    type LibraryRoleName,
    type LibrarySummary,
    type UserSummary,
  } from '../lib/api';
  import { navigate } from '../lib/router.svelte';

  type DraftRoleChoice = 'none' | LibraryRoleName;

  let usersOpen = $state(true);
  let users = $state<UserSummary[] | null>(null);
  let usersError = $state<string | null>(null);
  let currentUserId = $state<string | null>(null);
  let removeTarget = $state<UserSummary | null>(null);

  async function refreshUsers() {
    try {
      users = await fetchUsers();
      usersError = null;
    } catch (e) {
      usersError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void refreshUsers();
    fetchCurrentUser()
      .then((u) => (currentUserId = u.id))
      .catch(() => {});
  });

  async function confirmRemove() {
    if (!removeTarget) return;
    await removeUser(removeTarget.id);
    removeTarget = null;
    await refreshUsers();
  }

  let invitationsOpen = $state(true);
  let invitations = $state<InvitationSummary[] | null>(null);
  let invitationsError = $state<string | null>(null);
  let libraries = $state<LibrarySummary[]>([]);

  let draftGlobalRole = $state<'member' | 'admin'>('member');
  let draftExpiresIn = $state<number>(86400);
  let draftLibraryRoles = $state<Record<number, DraftRoleChoice>>({});
  let creating = $state(false);
  let createError = $state<string | null>(null);
  let createdCode = $state<string | null>(null);
  let copied = $state(false);
  let revokingId = $state<string | null>(null);

  async function refreshInvitations() {
    try {
      invitations = await fetchInvitations();
      invitationsError = null;
    } catch (e) {
      invitationsError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void refreshInvitations();
    fetchLibraries()
      .then((libs) => {
        libraries = libs;
      })
      .catch(() => {});
  });

  const pendingCount = $derived(
    (invitations ?? []).filter((inv) => inv.status === 'pending').length,
  );

  function statusLabel(status: InvitationStatus): string {
    switch (status) {
      case 'pending':
        return 'Pending';
      case 'used':
        return 'Used';
      case 'revoked':
        return 'Revoked';
      case 'expired':
        return 'Expired';
    }
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  function setLibraryRole(libraryId: number, value: string) {
    draftLibraryRoles = {
      ...draftLibraryRoles,
      [libraryId]: value as DraftRoleChoice,
    };
  }

  function resetDraft() {
    draftGlobalRole = 'member';
    draftExpiresIn = 86400;
    draftLibraryRoles = {};
    createError = null;
  }

  async function handleCreate() {
    if (creating) return;
    creating = true;
    createError = null;
    copied = false;
    try {
      const libraryRoles = Object.entries(draftLibraryRoles)
        .filter(([, role]) => role && role !== 'none')
        .map(([libId, role]) => ({
          libraryId: Number(libId),
          role: role as LibraryRoleName,
        }));

      const result = await createInvitation({
        isAdmin: draftGlobalRole === 'admin',
        expiresInSeconds: draftExpiresIn,
        libraryRoles,
      });
      resetDraft();
      await refreshInvitations();
      createdCode = result.code;
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }

  async function handleRevoke(id: string) {
    if (revokingId) return;
    revokingId = id;
    try {
      await revokeInvitation(id);
      await refreshInvitations();
    } catch (e) {
      invitationsError = e instanceof Error ? e.message : String(e);
    } finally {
      revokingId = null;
    }
  }

  async function copyCreatedCode() {
    if (!createdCode) return;
    try {
      await navigator.clipboard?.writeText(createdCode);
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

<div class="user-management-page">
  <nav class="breadcrumb">
    <button type="button" onclick={() => navigate('/settings')}>← Settings</button>
  </nav>

  <header class="page-header">
    <div class="title-block">
      <h1>User management</h1>
      <p class="description">Manage users, invitations, and permissions.</p>
    </div>
  </header>

  <section class="dropdown-section">
    <button
      type="button"
      class="dropdown-header"
      aria-expanded={usersOpen}
      onclick={() => (usersOpen = !usersOpen)}
    >
      <div class="dropdown-title-group">
        <Icon name={usersOpen ? 'chevron-down' : 'chevron-right'} size={16} />
        <div class="dropdown-title-text">
          <h2>Users</h2>
          <p class="section-subtitle">
            Remove a user to end all sessions of that user and delete the account.
          </p>
        </div>
      </div>
      <div class="dropdown-summary">
        <Pill label="{(users ?? []).length} users" />
      </div>
    </button>

    {#if usersOpen}
      <div class="dropdown-body">
        <div class="invitations-main">
          {#if usersError}
            <p class="error" role="alert">{usersError}</p>
          {:else if users === null}
            <p class="placeholder">Loading users…</p>
          {:else}
            <div class="invitation-list">
              {#each users as u (u.id)}
                <div class="invitation-card">
                  <div class="invitation-info">
                    <div class="invitation-badges">
                      <strong class="username">{u.username}</strong>
                      <Pill label={u.isAdmin ? 'Admin' : 'Member'} accent={u.isAdmin} />
                      {#if u.id === currentUserId}<Pill label="You" />{/if}
                    </div>
                    <div class="invitation-details">
                      <span class="meta">Created {formatDate(u.createdAt)}</span>
                    </div>
                  </div>
                  <div class="invitation-side">
                    {#if u.id !== currentUserId}
                      <Button label="Remove" onclick={() => (removeTarget = u)} />
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </section>

  {#if removeTarget}
    <ConfirmationModal
      title="Remove {removeTarget.username}"
      message="This deletes the account of {removeTarget.username} and ends all sessions of that user. Tags and files stay."
      confirmLabel="Remove user"
      onConfirm={confirmRemove}
      onCancel={() => (removeTarget = null)}
    />
  {/if}

  <section class="dropdown-section">
    <button
      type="button"
      class="dropdown-header"
      aria-expanded={invitationsOpen}
      onclick={() => (invitationsOpen = !invitationsOpen)}
    >
      <div class="dropdown-title-group">
        <Icon name={invitationsOpen ? 'chevron-down' : 'chevron-right'} size={16} />
        <div class="dropdown-title-text">
          <h2>Invitations</h2>
          <p class="section-subtitle">
            Create invitation codes, set permissions for invited users, and revoke pending invites.
          </p>
        </div>
      </div>
      <div class="dropdown-summary">
        <Pill label="{pendingCount} pending" accent={pendingCount > 0} />
        <Pill label="{(invitations ?? []).length} total" />
      </div>
    </button>

    {#if invitationsOpen}
      <div class="dropdown-body">
        <div class="invitations-main">
          {#if createdCode !== null}
            <div class="created-banner" role="status">
              <div class="created-banner-info">
                <span class="created-banner-label">New invitation code (shown only once)</span>
                <code class="created-code">{createdCode}</code>
              </div>
              <div class="created-banner-actions">
                <Button
                  label={copied ? 'Copied' : 'Copy code'}
                  accent
                  onclick={() => void copyCreatedCode()}
                />
                <Button label="Dismiss" onclick={() => (createdCode = null)} />
              </div>
            </div>
          {/if}

          {#if invitationsError}
            <p class="error" role="alert">{invitationsError}</p>
          {:else if invitations === null}
            <p class="placeholder">Loading invitations…</p>
          {:else if invitations.length === 0}
            <p class="placeholder">No invitations yet. Create one from the panel on the right.</p>
          {:else}
            <div class="invitation-list">
              {#each invitations as inv (inv.id)}
                <div class="invitation-card">
                  <div class="invitation-info">
                    <div class="invitation-badges">
                      <Pill label={statusLabel(inv.status)} accent={inv.status === 'pending'} />
                      <Pill label={inv.isAdmin ? 'Admin' : 'Member'} accent={inv.isAdmin} />
                      {#each inv.libraryRoles as grant (grant.libraryId)}
                        <Pill label="{grant.libraryName}: {grant.role}" />
                      {/each}
                    </div>
                    <div class="invitation-details">
                      {#if inv.used}
                        <span class="claimant">
                          Created user: <strong>{inv.claimantUsername ?? 'Unknown'}</strong>
                        </span>
                      {:else if inv.status === 'pending'}
                        <span class="meta">
                          Pending · Expires {formatDate(inv.expiresAt)}
                        </span>
                      {:else if inv.status === 'revoked'}
                        <span class="meta">Revoked</span>
                      {:else}
                        <span class="meta">Expired {formatDate(inv.expiresAt)}</span>
                      {/if}
                      {#if inv.issuerUsername}
                        <span class="meta">Issued by {inv.issuerUsername}</span>
                      {/if}
                    </div>
                  </div>
                  <div class="invitation-side">
                    {#if inv.status === 'pending'}
                      <Button
                        label="Revoke"
                        disabled={revokingId === inv.id}
                        onclick={() => void handleRevoke(inv.id)}
                      />
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <aside class="new-invitation-panel">
          <header class="panel-header">
            <p class="panel-title">New invitation</p>
            <Pill label="draft" accent />
          </header>

          <label class="field">
            <span class="label">Global role</span>
            <select aria-label="Global role" bind:value={draftGlobalRole} disabled={creating}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>

          <label class="field">
            <span class="label">Expires in</span>
            <select aria-label="Expires in" bind:value={draftExpiresIn} disabled={creating}>
              <option value={3600}>1 hour</option>
              <option value={86400}>24 hours</option>
              <option value={604800}>7 days</option>
              <option value={2592000}>30 days</option>
            </select>
          </label>

          <div class="library-permissions">
            <span class="label">Library permissions</span>
            {#if libraries.length === 0}
              <p class="hint">No libraries yet.</p>
            {:else}
              <div class="library-roles-list">
                {#each libraries as lib (lib.library_id)}
                  <label class="library-role-row">
                    <span class="library-role-name" title={lib.root_path ?? undefined}
                      >{lib.name}</span
                    >
                    <select
                      aria-label="Role for {lib.name}"
                      value={draftLibraryRoles[lib.library_id] ?? 'none'}
                      onchange={(e) => setLibraryRole(lib.library_id, e.currentTarget.value)}
                      disabled={creating}
                    >
                      <option value="none">No access</option>
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="owner">Owner</option>
                    </select>
                  </label>
                {/each}
              </div>
            {/if}
          </div>

          {#if createError}
            <p class="error" role="alert">{createError}</p>
          {/if}

          <div class="panel-actions">
            <Button
              label={creating ? 'Creating…' : 'Create invitation'}
              accent
              disabled={creating}
              onclick={() => void handleCreate()}
            />
            <Button label="Reset" disabled={creating} onclick={resetDraft} />
          </div>
        </aside>
      </div>
    {/if}
  </section>
</div>

<style lang="scss">
  @use '../styles/variables' as *;

  .user-management-page {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px;
    background: $color-shell-bg;
    min-height: 100vh;
  }

  .breadcrumb button {
    padding: 0;
    font-family: inherit;
    font-size: 13px;
    color: $color-text-dim;
    background: none;
    border: 0;
    cursor: pointer;

    &:hover {
      color: $color-text-strong;
    }
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .title-block h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 600;
    color: $color-jobs-accent;
  }

  .description {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .dropdown-section {
    display: flex;
    flex-direction: column;
    background: $color-sidebar-bg;
    border-radius: 2px;
  }

  .dropdown-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 12px;
    font-family: inherit;
    text-align: left;
    color: $color-text-strong;
    background: transparent;
    border: 0;
    cursor: pointer;

    &:hover {
      background: $color-panel-bg;
    }
  }

  .dropdown-title-group {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .dropdown-title-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;

    h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: $color-text-strong;
    }
  }

  .section-subtitle {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .dropdown-summary {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .dropdown-body {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 0 12px 12px;
  }

  .invitations-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .created-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    background: $color-panel-bg;
    border-radius: 2px;
  }

  .created-banner-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .created-banner-label {
    font-size: 11px;
    font-weight: 600;
    color: $color-jobs-accent;
  }

  .created-code {
    font-family: $font-mono;
    font-size: 13px;
    color: $color-text-strong;
    word-break: break-all;
  }

  .created-banner-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .invitation-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .invitation-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    background: $color-panel-bg;
    border-radius: 2px;
  }

  .invitation-info {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .invitation-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  .invitation-details {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 12px;
    color: $color-text-dim;
  }

  .claimant strong,
  .username {
    color: $color-text-strong;
  }

  .username {
    font-size: 13px;
  }

  .invitation-side {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .new-invitation-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex-shrink: 0;
    width: 340px;
    padding: 12px;
    background: $color-panel-bg;
    border-radius: 2px;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .label {
    font-size: 11px;
    color: $color-text-dim;
  }

  select {
    width: 100%;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 13px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
  }

  .library-permissions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .library-roles-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .library-role-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;

    select {
      width: 150px;
      flex-shrink: 0;
    }
  }

  .library-role-name {
    font-size: 13px;
    color: $color-text-strong;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint {
    margin: 0;
    font-size: 11px;
    color: $color-text-dim;
  }

  .placeholder {
    margin: 0;
    font-size: 13px;
    color: $color-text-dim;
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: $color-error;
  }

  .panel-actions {
    display: flex;
    gap: 8px;
  }
</style>
