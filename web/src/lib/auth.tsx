import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, refreshSession, setAccessToken } from './api';
import type { Me, Role } from './types';

interface Session {
  user: Me;
  accessToken: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  role: Exclude<Role, 'ADMIN'>;
  doctor?: { specialization: string; qualification?: string; experienceYears?: number };
}

interface AuthState {
  user: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<Me>;
  register: (input: RegisterInput) => Promise<Me>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

// Non-sensitive hint that a refresh cookie may exist; avoids a guaranteed 401 for anonymous visitors.
const HINT = 'qfree.session';
function hadSession() {
  try {
    return localStorage.getItem(HINT) === '1';
  } catch {
    return true;
  }
}
function rememberSession(on: boolean) {
  try {
    if (on) localStorage.setItem(HINT, '1');
    else localStorage.removeItem(HINT);
  } catch {
    /* storage unavailable */
  }
}

const AuthContext = createContext<AuthState | null>(null);

export const homeFor = (role: Role) =>
  ({ PATIENT: '/patient', DOCTOR: '/doctor', ORG_ADMIN: '/org', ADMIN: '/admin' })[role];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  // Restore the session from the refresh cookie on first load.
  useEffect(() => {
    if (!hadSession()) {
      setLoading(false);
      return;
    }
    refreshSession<Session>()
      .then((s) => setUser(s.user))
      .catch(() => {
        rememberSession(false);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const accept = useCallback((s: Session) => {
    setAccessToken(s.accessToken);
    rememberSession(true);
    setUser(s.user);
    return s.user;
  }, []);

  const login = useCallback(
    async (email: string, password: string) => accept(await api.post<Session>('/auth/login', { email, password })),
    [accept],
  );
  const register = useCallback(async (input: RegisterInput) => accept(await api.post<Session>('/auth/register', input)), [accept]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setAccessToken(null);
    rememberSession(false);
    setUser(null);
    qc.clear();
  }, [qc]);

  const reload = useCallback(async () => setUser(await api.get<Me>('/auth/me')), []);

  const value = useMemo(() => ({ user, loading, login, register, logout, reload }), [user, loading, login, register, logout, reload]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
