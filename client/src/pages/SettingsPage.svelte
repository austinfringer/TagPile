<script lang="ts">
  import Button from '../lib/Button.svelte';
  import { changePassword, fetchCurrentUser, passwordProblem, type CurrentUser } from '../lib/api';
  import { navigate } from '../lib/router.svelte';

  let user = $state<CurrentUser | null>(null);
  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let saving = $state(false);
  let passwordError = $state<string | null>(null);
  let passwordChanged = $state(false);

  $effect(() => {
    fetchCurrentUser()
      .then((u) => (user = u))
      .catch(() => {});
  });

  async function submitPassword(event: SubmitEvent) {
    event.preventDefault();
    passwordChanged = false;
    passwordError =
      passwordProblem(newPassword) ??
      (newPassword !== confirmPassword ? 'The new passwords are not the same.' : null);
    if (passwordError) return;
    saving = true;
    try {
      await changePassword(currentPassword, newPassword);
      currentPassword = newPassword = confirmPassword = '';
      passwordChanged = true;
    } catch (e) {
      passwordError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<div class="settings-page">
  <header class="settings-header">
    <div class="title-block">
      <h1>Settings</h1>
      <p class="description">Configure server access, invitations, and account settings.</p>
    </div>
  </header>

  <section class="settings-card account-card">
    <div class="settings-card-info">
      <h2>Account</h2>
      <p class="section-subtitle">
        {#if user}Signed in as <strong>{user.username}</strong>.{/if}
        A password change signs you out on all other devices.
      </p>
    </div>
    <form class="password-form" onsubmit={submitPassword}>
      <label>
        <span>Current password</span>
        <input
          type="password"
          autocomplete="current-password"
          bind:value={currentPassword}
          disabled={saving}
          required
        />
      </label>
      <label>
        <span>New password</span>
        <input
          type="password"
          autocomplete="new-password"
          bind:value={newPassword}
          disabled={saving}
          required
        />
      </label>
      <label>
        <span>Confirm new password</span>
        <input
          type="password"
          autocomplete="new-password"
          bind:value={confirmPassword}
          disabled={saving}
          required
        />
      </label>
      {#if passwordError}
        <p class="error" role="alert">{passwordError}</p>
      {/if}
      {#if passwordChanged}
        <p class="ok" role="status">Password changed.</p>
      {/if}
      <button type="submit" disabled={saving}>Change password</button>
    </form>
  </section>

  {#if user?.isAdmin}
    <section class="settings-card">
      <div class="settings-card-info">
        <h2>Users &amp; Invitations</h2>
        <p class="section-subtitle">
          Create invitation codes, set permissions for invited users, and remove users.
        </p>
      </div>
      <Button label="User management" accent onclick={() => navigate('/settings/users')} />
    </section>
  {/if}
</div>

<style lang="scss">
  @use '../styles/variables' as *;

  .settings-page {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px;
    background: $color-shell-bg;
    min-height: 100vh;
  }

  .settings-header {
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

  .settings-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    background: $color-sidebar-bg;
    border-radius: 2px;
  }

  .settings-card-info {
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

  .account-card {
    flex-direction: column;
    align-items: stretch;
  }

  .password-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 320px;

    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: $color-text-dim;
    }

    input {
      padding: 6px 8px;
      font: inherit;
      color: $color-text-strong;
      background: $color-chip-bg;
      border: 0;
      border-radius: 2px;
    }

    button {
      align-self: flex-start;
      padding: 8px 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      color: $color-jobs-accent;
      background: $color-chip-bg;
      border: 0;
      border-radius: 2px;
      cursor: pointer;

      &:disabled {
        opacity: 0.5;
        cursor: wait;
      }
    }

    .error,
    .ok {
      margin: 0;
      font-size: 12px;
    }

    .error {
      color: $color-error;
    }

    .ok {
      color: $color-ok;
    }
  }
</style>
