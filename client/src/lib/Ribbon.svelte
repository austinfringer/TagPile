<script lang="ts">
  import { logout } from './api';
  import Icon from './Icon.svelte';
  import { currentPath, navigate } from './router.svelte';
  import type { IconName } from './icons';

  interface NavItem {
    label: string;
    icon: IconName;
    path: string;
  }

  const items: NavItem[] = [
    { label: 'Browse', icon: 'squares-2x2', path: '/' },
    { label: 'Tag', icon: 'tag', path: '/tag' },
    { label: 'Manage tags', icon: 'share', path: '/tags' },
    { label: 'Libraries', icon: 'building-library', path: '/libraries' },
    { label: 'Jobs', icon: 'server', path: '/jobs' },
    { label: 'Settings', icon: 'cog-6-tooth', path: '/settings' },
  ];

  async function signOut() {
    await logout().catch(() => {});
    window.location.href = '/login';
  }

  function isActive(item: NavItem): boolean {
    const path = currentPath();
    return path === item.path || (item.path !== '/' && path.startsWith(`${item.path}/`));
  }
</script>

<nav class="ribbon" aria-label="Main navigation">
  {#each items as item (item.path)}
    <button
      type="button"
      class="ribbon-item"
      class:active={isActive(item)}
      aria-current={isActive(item) ? 'page' : undefined}
      onclick={() => navigate(item.path)}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
    </button>
  {/each}
  <div class="spacer"></div>
  <button type="button" class="ribbon-item" onclick={() => void signOut()}>
    <Icon name="arrow-right-on-rectangle" />
    <span>Log out</span>
  </button>
  <span class="ribbon-footer" title="Help">
    <Icon name="question-mark-circle" />
  </span>
</nav>

<style lang="scss">
  @use '../styles/variables' as *;

  .ribbon {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    width: 76px;
    padding: 12px 0;
    background: $color-ribbon-bg;
  }

  .ribbon-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    width: 64px;
    height: 52px;
    margin-bottom: 8px;
    font-family: inherit;
    font-size: 10px;
    color: $color-text-inactive;
    background: transparent;
    border: 0;
    border-radius: 2px;
    cursor: pointer;

    &:hover {
      background: $color-panel-bg;
    }

    &.active {
      color: $color-jobs-accent;
      background: $color-chip-bg;
    }
  }

  .spacer {
    flex: 1;
  }

  .ribbon-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    color: $color-text-inactive;
  }
</style>
