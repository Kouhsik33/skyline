import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './AuthProvider';
import { RequireAuth } from './guards';
import { installBfcacheGuard } from './clientState';
import { authApi } from '../api/endpoints';
import { request } from '../api/client';

// B5 / B6: logout and login must leave no data from the previous user in the client; protected
// routes wait for /auth/me instead of redirecting while it is still loading.

jest.mock('../api/endpoints', () => ({
  authApi: { me: jest.fn(), logout: jest.fn() },
}));
jest.mock('../api/config', () => ({ API_MODE: 'live', API_BASE_URL: '/api/v1', IS_DEMO: false }));

const USER_A = { user: { id: 'a', fullName: 'First User' }, capabilities: { clubRoles: [] } };
const USER_B = { user: { id: 'b', fullName: 'Second User' }, capabilities: { clubRoles: [] } };

let auth;
function Probe() {
  auth = useAuth();
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

function setup(qc, path = '/private') {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <Probe />
          <Routes>
            <Route path="/login" element={<div>login page</div>} />
            <Route path="/private" element={<RequireAuth><div>private page</div></RequireAuth>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  global.fetch = undefined;
});

test('signOut: server logout, query cache cleared, auth state cleared, carts cleared, lands on /login', async () => {
  authApi.me.mockResolvedValue(USER_A);
  authApi.logout.mockResolvedValue(null);
  const qc = newClient();
  qc.setQueryData(['me', 'payments'], [{ id: 'pay-of-a' }]);
  window.sessionStorage.setItem('soms.cart.club-1', JSON.stringify([{ variantId: 'v', quantity: 1 }]));
  window.localStorage.setItem('soms.lastClub', 'club-1');
  window.localStorage.setItem('soms.theme', 'dark'); // not user data: must survive

  setup(qc);
  await screen.findByText('private page');
  await act(async () => {
    await auth.signOut();
  });

  expect(authApi.logout).toHaveBeenCalledTimes(1);
  expect(qc.getQueryData(['me', 'payments'])).toBeUndefined();
  expect(auth.user).toBeNull();
  expect(window.sessionStorage.getItem('soms.cart.club-1')).toBeNull();
  expect(window.localStorage.getItem('soms.lastClub')).toBeNull();
  expect(window.localStorage.getItem('soms.theme')).toBe('dark');
  expect(screen.getByTestId('where')).toHaveTextContent('/login');
  expect(screen.queryByText('private page')).toBeNull();
});

test('signOut clears client state even if the network call fails', async () => {
  authApi.me.mockResolvedValue(USER_A);
  authApi.logout.mockRejectedValue(new Error('offline'));
  const qc = newClient();
  qc.setQueryData(['orders'], ['of-a']);
  setup(qc);
  await screen.findByText('private page');
  await act(async () => {
    await auth.signOut().catch(() => {});
  });
  expect(qc.getQueryData(['orders'])).toBeUndefined();
  expect(screen.getByTestId('where')).toHaveTextContent('/login');
});

test('setSession (login as a second user) drops every cached query of the previous user', async () => {
  authApi.me.mockResolvedValue(null);
  const qc = newClient();
  setup(qc, '/login');
  await waitFor(() => expect(auth.loading).toBe(false));
  // Data left over from user A (e.g. their session expired without an explicit logout).
  qc.setQueryData(['me', 'orders'], ['order-of-a']);
  act(() => auth.setSession(USER_B));
  expect(qc.getQueryData(['me', 'orders'])).toBeUndefined();
  expect(auth.user).toEqual(USER_B.user);
});

test('a 401 while signed in (session expired) clears the cache; a 401 while anonymous does not loop', async () => {
  authApi.me.mockResolvedValue(USER_A);
  const qc = newClient();
  qc.setQueryData(['finance', 'club-1'], { balance: 1 });
  setup(qc);
  await screen.findByText('private page');

  global.fetch = jest.fn().mockResolvedValue({
    status: 401,
    headers: { get: (h) => (h === 'content-type' ? 'application/json' : null) },
    json: async () => ({ error: { code: 'UNAUTHENTICATED' } }),
  });
  await act(async () => {
    await request('GET', '/me/payments').catch(() => {});
  });
  expect(qc.getQueryData(['finance', 'club-1'])).toBeUndefined();
  expect(auth.user).toBeNull();
  const calls = authApi.me.mock.calls.length;
  await act(async () => {
    await request('GET', '/me/payments').catch(() => {});
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(authApi.me.mock.calls.length).toBe(calls); // no refetch storm
});

test('refresh on a protected page: no redirect to /login while /auth/me is pending', async () => {
  let resolveMe;
  authApi.me.mockReturnValue(new Promise((r) => (resolveMe = r)));
  setup(newClient());
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.getByTestId('where')).toHaveTextContent('/private');
  expect(screen.queryByText('login page')).toBeNull();
  await act(async () => resolveMe(USER_A));
  expect(await screen.findByText('private page')).toBeInTheDocument();
  expect(screen.getByTestId('where')).toHaveTextContent('/private');
});

test('bfcache guard: a page restored from the back-forward cache is reloaded', () => {
  const reload = jest.fn();
  const remove = installBfcacheGuard(window, reload);
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
  expect(reload).not.toHaveBeenCalled();
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  expect(reload).toHaveBeenCalledTimes(1);
  remove();
});
