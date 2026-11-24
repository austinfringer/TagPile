<script lang="ts">
  import LoginForm from './lib/LoginForm.svelte';
  import InvitationForm from './lib/InvitationForm.svelte';

  let mode = $state<'login' | 'invite'>('login');
</script>

<main>
  <section class="login-card" aria-labelledby="login-title">
    <header>
      <p class="brand">TagPile</p>
      {#if mode === 'login'}
        <h1 id="login-title">Welcome back</h1>
        <p class="intro">Sign in to continue to your account.</p>
      {:else}
        <h1 id="login-title">Redeem your invitation</h1>
        <p class="intro">Create an account using your invitation code.</p>
      {/if}
    </header>

    {#if mode === 'login'}
      <LoginForm onSwitchToInvite={() => (mode = 'invite')} />
    {:else}
      <InvitationForm onSwitchToLogin={() => (mode = 'login')} />
    {/if}

    <p class="invite-note">Accounts are available by invitation only.</p>
  </section>
</main>

<style lang="scss">
  @use './styles/variables' as *;

  main {
    display: grid;
    min-height: 100vh;
    padding: $space-4 $space-3;
    place-items: center;
  }

  .login-card {
    width: min(100%, 26rem);
    padding: $space-4;
    border: 0;
    border-radius: 0.75rem;
    background: $color-panel-bg;
    box-shadow: 0 1.5rem 4rem rgb(0 0 0 / 0.25);
  }

  header {
    margin-bottom: $space-4;
  }

  .brand {
    margin: 0 0 $space-2;
    color: $color-accent;
    font-weight: 800;
    letter-spacing: 0.04em;
  }

  h1 {
    margin: 0;
    font-size: 1.75rem;
    line-height: 1.2;
  }

  .intro,
  .invite-note {
    color: $color-muted;
  }

  .intro {
    margin: $space-2 0 0;
  }

  .invite-note {
    margin: $space-4 0 0;
    font-size: 0.8rem;
    text-align: center;
  }

  @media (max-width: 30rem) {
    main {
      padding: $space-3;
    }

    .login-card {
      padding: $space-4 $space-3;
    }
  }
</style>
