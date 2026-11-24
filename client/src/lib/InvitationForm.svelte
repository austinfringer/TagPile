<script lang="ts">
  import { ApiError, login, passwordProblem, redeem } from './api';

  let { onSwitchToLogin }: { onSwitchToLogin?: () => void } = $props();

  let username = $state('');
  let password = $state('');
  let code = $state('');
  let error = $state<string | null>(null);
  let success = $state(false);
  let submitting = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = passwordProblem(password);
    success = false;
    if (error) return;
    submitting = true;

    try {
      await redeem(code, username, password);
      await login(username, password);
      success = true;
      window.location.href = '/';
    } catch (e) {
      // A bad code stays generic; other errors (taken username, rate limit) are useful.
      error =
        e instanceof ApiError && e.status !== 401 && e.body?.error
          ? e.body.error
          : 'Invalid code, username or password.';
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
      autocomplete="new-password"
      aria-describedby="password-hint"
      bind:value={password}
      disabled={submitting}
      required
    />
    <span id="password-hint" class="hint">At least 8 characters. Spaces are permitted.</span>
  </div>

  <div class="field">
    <label for="code">Invitation Code</label>
    <input id="code" name="code" type="text" bind:value={code} disabled={submitting} required />
  </div>

  {#if error}
    <p class="message error" role="alert">{error}</p>
  {/if}

  {#if success}
    <p class="message success" role="status">Account created successfully.</p>
  {/if}

  <button type="submit" disabled={submitting}>
    {submitting ? 'Creating account…' : 'Create account'}
  </button>

  {#if onSwitchToLogin}
    <button type="button" class="switch-link" onclick={onSwitchToLogin}>
      Already have an account? Sign in
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

  .hint {
    font-size: 0.8rem;
    opacity: 0.75;
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
