// Everything the browser keeps for the signed-in user, in one place (B5): signing out, a new
// sign-in and an expired session all wipe it, so nothing of one user is shown to the next.

export const CART_KEY_PREFIX = 'soms.cart.';
export const LAST_CLUB_KEY = 'soms.lastClub';

function removeKeys(storage, match) {
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
    keys.filter(match).forEach((k) => storage.removeItem(k));
  } catch {
    /* storage unavailable (private mode) — nothing persisted */
  }
}

/** Drop all user data held in the browser: query cache, carts, last managed club. */
export function clearClientState(queryClient) {
  queryClient.cancelQueries();
  queryClient.clear();
  if (typeof window === 'undefined') return;
  removeKeys(window.sessionStorage, (k) => k.startsWith(CART_KEY_PREFIX));
  removeKeys(window.localStorage, (k) => k.startsWith(CART_KEY_PREFIX) || k === LAST_CLUB_KEY);
}

/**
 * A page restored from the back-forward cache still holds the previous user's rendered data.
 * Reload it so /auth/me runs again (Back after logout shows the sign-in page, not private data).
 */
export function installBfcacheGuard(win = window, reload = () => win.location.reload()) {
  const onPageShow = (e) => {
    if (e.persisted) reload();
  };
  win.addEventListener('pageshow', onPageShow);
  return () => win.removeEventListener('pageshow', onPageShow);
}
