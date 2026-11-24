<script lang="ts">
  import './lib/jobs'; // registers the built-in job types
  import ContextMenu from './lib/contextmenu/ContextMenu.svelte';
  import Ribbon from './lib/Ribbon.svelte';
  import { currentPath } from './lib/router.svelte';
  import JobDetailPage from './pages/JobDetailPage.svelte';
  import JobsPage from './pages/JobsPage.svelte';
  import LibrariesPage from './pages/LibrariesPage.svelte';
  import ManageTagsPage from './pages/ManageTagsPage.svelte';
  import PlaceholderPage from './pages/PlaceholderPage.svelte';
  import SettingsPage from './pages/SettingsPage.svelte';
  import TagDetailPage from './pages/TagDetailPage.svelte';
  import TagPage from './pages/TagPage.svelte';
  import UserManagementPage from './pages/UserManagementPage.svelte';

  const path = $derived(currentPath());
  const jobIdFromPath = (p: string): string | null => {
    const match = /^\/jobs\/([^/]+)$/.exec(p);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  };
  const tagIdFromPath = (p: string): string | null => {
    const match = /^\/tags\/([^/]+)$/.exec(p);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  };
  const fileIdFromPath = (p: string): string | null => {
    const match = /^\/files\/([^/]+)$/.exec(p);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  };
</script>

<div class="shell">
  <Ribbon />
  <div class="page">
    {#if path === '/jobs'}
      <JobsPage />
    {:else if jobIdFromPath(path) !== null}
      {#key jobIdFromPath(path)}
        <JobDetailPage id={jobIdFromPath(path)!} />
      {/key}
    {:else if path === '/libraries'}
      <LibrariesPage />
    {:else if path === '/tag'}
      <TagPage />
    {:else if path === '/tags'}
      <ManageTagsPage />
    {:else if tagIdFromPath(path) !== null}
      {#key tagIdFromPath(path)}
        <TagDetailPage id={tagIdFromPath(path)!} />
      {/key}
    {:else if fileIdFromPath(path) !== null}
      <PlaceholderPage label="File #{fileIdFromPath(path)}" />
    {:else if path === '/settings/users'}
      <UserManagementPage />
    {:else if path === '/settings'}
      <SettingsPage />
    {:else}
      <PlaceholderPage label="Browse" />
    {/if}
  </div>
</div>

<ContextMenu />

<style lang="scss">
  @use './styles/variables' as *;

  .shell {
    display: flex;
    align-items: stretch;
    min-height: 100vh;
    gap: 0px;
    padding: 0px;
    background: $color-shell-bg;
  }

  .page {
    display: flex;
    flex: 1;
    min-width: 0;

    > :global(*) {
      flex: 1;
      min-width: 0;
    }
  }
</style>
