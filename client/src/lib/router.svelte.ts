/** Tiny pushState router: the app shell is a single-page app whose paths (`/`, `/tag`, `/tags`,
 *  `/tags/:id`, `/libraries`, `/jobs`, `/jobs/:id`, `/settings`, `/settings/users`) the server serves identically in production. */

let path = $state(typeof window === 'undefined' ? '/' : window.location.pathname);

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    path = window.location.pathname;
  });
}

export function currentPath(): string {
  return path;
}

/** Number of in-app navigations that led to the current history entry. */
const depth = () => (window.history.state as { depth?: number } | null)?.depth ?? 0;

export function navigate(to: string): void {
  if (to === path) return;
  window.history.pushState({ depth: depth() + 1 }, '', to);
  path = to;
}

/** Returns to the page the user came from. Goes to `fallback` when the current page is
 *  the first page of the session, such as after a direct link or a reload. */
export function goBack(fallback: string): void {
  if (depth() > 0) window.history.back();
  else navigate(fallback);
}
