import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/endpoints';
import { onUnauthorized } from '../api/client';
import { clearClientState } from './clientState';

const AuthContext = createContext(null);

/**
 * Session state comes from GET /auth/me. Capabilities only drive navigation —
 * the backend re-checks every permission (LLD §6, HLD §5).
 */
export function AuthProvider({ children }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // queryClient.clear() detaches the live ['me'] observer from the cache; re-rendering makes it
  // attach to the fresh entry, so a new identity (or null) shows at once.
  const [, rerender] = useReducer((n) => n + 1, 0);
  const wipe = useCallback(
    (nextMe) => {
      clearClientState(qc);
      qc.setQueryData(['me'], nextMe);
      rerender();
    },
    [qc],
  );
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me().catch((e) => (e.code === 'UNAUTHENTICATED' ? null : Promise.reject(e))),
    staleTime: 60000,
    retry: false,
  });

  useEffect(() => {
    // Session expired or revoked: wipe the previous user's data. Only when someone was signed in —
    // clearing while anonymous would drop the pending /auth/me query and refetch it in a loop.
    onUnauthorized(() => {
      if (qc.getQueryData(['me'])) wipe(null);
      else qc.setQueryData(['me'], null);
    });
  }, [qc, wipe]);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ['me'] }), [qc]);
  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      wipe(null);
      navigate('/login', { replace: true });
    }
  }, [wipe, navigate]);

  // A new sign-in starts from an empty cache, whatever the previous user left behind.
  const setSession = useCallback((payload) => wipe(payload), [wipe]);

  const value = useMemo(() => {
    const data = me.data;
    const caps = data?.capabilities;
    const rolesIn = (clubId) => (caps?.clubRoles || []).filter((r) => r.clubId === clubId).map((r) => r.role);
    return {
      loading: me.isPending,
      error: me.error,
      user: data?.user || null,
      capabilities: caps || null,
      refresh,
      signOut,
      setSession,
      rolesIn,
      hasRole: (clubId, ...roles) => rolesIn(clubId).some((r) => roles.includes(r)),
      isVerified: !!caps?.verifiedStudent,
      membershipIn: (clubId) => (caps?.memberships || []).find((m) => m.clubId === clubId) || null,
      managedClubIds: [...new Set([...(caps?.clubRoles || []).map((r) => r.clubId)])],
      organizerOf: caps?.organizerOf || [],
      staffOf: caps?.staffOf || [],
    };
  }, [me.data, me.isPending, me.error, refresh, signOut, setSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
