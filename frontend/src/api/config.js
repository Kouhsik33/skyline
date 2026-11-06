// REACT_APP_API_MODE:
//   'live' — talk to the Express backend at REACT_APP_API_BASE_URL (default /api/v1, proxied in dev).
//   'mock' — in-browser demo backend implementing the LLD §4 contract with seeded data.
// The backend does not exist yet, so 'mock' is the default until it does.
export const API_MODE = (process.env.NODE_ENV === 'test' ? 'mock' : (process.env.REACT_APP_API_MODE || 'live')).toLowerCase();
export const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '/api/v1';
export const IS_DEMO = API_MODE === 'mock';

// One-click demo sign-in buttons: show by default unless explicitly disabled.
export const SHOW_DEMO_LOGINS = process.env.REACT_APP_SHOW_DEMO_ACCOUNTS !== 'false';
