<script lang="ts">
  import { ApiError, login } from './api';

  let { onSwitchToInvite }: { onSwitchToInvite?: () => void } = $props();

  let username = $state('');
  let password = $state('');
  let error = $state<string | null>(null);
  let success = $state(false);
  let submitting = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    success = false;
    submitting = true;

    try {
      await login(username, password);
      success = true;
      window.location.href = '/';
    } catch (e) {
      error =
        e instanceof ApiError && e.status === 429
          ? 'Too many failed attempts. Wait 15 minutes, then try again.'
          : 'Invalid username or password.';
    } finally {
      submitting = false;
    }
  }
</script>

<form onsubmit={submit}>
  <div class="field">
    <label for="username">Username</label>
    <input
      id="username"
      name="username"
      type="text"
      autocomplete="username"
      bind:value={username}
      disabled={submitting}
      required
    />
  </div>

  <div class="field">
    <label for="password">Password</label>
    <input
      id="password"
      name="password"
      type="password"
      autocomplete="current-password"
      bind:value={password}
      disabled={submitting}
      required
    />
  </div>

  {#if error}
    <p class="message error" role="alert">{error}</p>
  {/if}

  {#if success}
    <p class="message success" role="status">Signed in successfully.</p>
  {/if}

  <button type="submit" disabled={submitting}>
    {submitting ? 'Signing in…' : 'Sign in'}
  </button>

  {#if onSwitchToInvite}
    <button type="button" class="switch-link" onclick={onSwitchToInvite}>
      Have an invitation code? Redeem it
    </button>
  {/if}
</form>

<style lang="scss">
  @use '../styles/variables' as *;

  form {
    display: flex;
    flex-direction: column;
    gap: $space-3;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: $space-2;
  }

  label {
    font-size: 0.875rem;
    font-weight: 650;
  }

  input {
    width: 100%;
    padding: 0.75rem;
    border: 0;
    border-radius: 0.375rem;
    color: $color-fg;
    background: $color-chip-bg;
    font: inherit;

    &:focus {
      border-color: $color-accent;
      outline: 2px solid rgba($color-accent, 0.25);
      outline-offset: 1px;
    }

    &:disabled {
      opacity: 0.65;
    }
  }

  button {
    min-height: 2.75rem;
    margin-top: $space-1;
    border: 0;
    border-radius: 0.375rem;
    color: #fff;
    background: $color-accent;
    font: inherit;
    font-weight: 700;
    cursor: pointer;

    &:hover:not(:disabled) {
      filter: brightness(1.1);
    }

    &:focus-visible {
      outline: 2px solid $color-fg;
      outline-offset: 2px;
    }

    &:disabled {
      cursor: wait;
      opacity: 0.7;
    }
  }

  .message {
    margin: 0;
    font-size: 0.875rem;
  }

  .error {
    color: $color-error;
  }

  .success {
    color: $color-ok;
  }

  .switch-link {
    padding: 0;
    border: 0;
    background: none;
    color: $color-accent;
    font: inherit;
    font-size: 0.85rem;
    text-align: center;
    cursor: pointer;

    &:hover {
      text-decoration: underline;
    }

    &:focus-visible {
      outline: 2px solid $color-fg;
      outline-offset: 2px;
    }
  }
</style>
