import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, Bell, Building2, CalendarClock, ClipboardList, Clock, FlaskConical, History, LayoutDashboard, ListOrdered,
  LogOut, Menu, Search, Settings, ShieldCheck, Stethoscope, TestTubes, User, Users, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getSocket } from '../lib/socket';
import type { Notification, Role } from '../lib/types';
import { useToast } from '../components/ui/Toast';
import { useSocketConnected } from '../hooks/useLive';
import { Logo } from './Logo';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

const i = (C: typeof Bell) => <C className="size-5" aria-hidden />;

const NAV: Record<Role, NavItem[]> = {
  PATIENT: [
    { to: '/patient', label: 'Dashboard', icon: i(LayoutDashboard), end: true },
    { to: '/search', label: 'Find care', icon: i(Search) },
    { to: '/patient/queues', label: 'My queues', icon: i(ListOrdered) },
    { to: '/patient/history', label: 'Visit history', icon: i(History) },
    { to: '/notifications', label: 'Notifications', icon: i(Bell) },
    { to: '/patient/profile', label: 'Profile', icon: i(User) },
  ],
  DOCTOR: [
    { to: '/doctor', label: 'Dashboard', icon: i(LayoutDashboard), end: true },
    { to: '/doctor/queue', label: "Today's queue", icon: i(ListOrdered) },
    { to: '/doctor/history', label: 'Queue history', icon: i(History) },
    { to: '/doctor/schedule', label: 'Schedule', icon: i(CalendarClock) },
    { to: '/doctor/analytics', label: 'Analytics', icon: i(BarChart3) },
    { to: '/notifications', label: 'Notifications', icon: i(Bell) },
    { to: '/doctor/profile', label: 'Profile', icon: i(User) },
  ],
  ORG_ADMIN: [
    { to: '/org', label: 'Dashboard', icon: i(LayoutDashboard), end: true },
    { to: '/org/queues', label: 'Queues', icon: i(ListOrdered) },
    { to: '/org/doctors', label: 'Doctors', icon: i(Stethoscope) },
    { to: '/org/services', label: 'Services', icon: i(TestTubes) },
    { to: '/org/staff', label: 'Staff', icon: i(Users) },
    { to: '/org/hours', label: 'Operating hours', icon: i(Clock) },
    { to: '/org/reports', label: 'Reports', icon: i(ClipboardList) },
    { to: '/org/analytics', label: 'Analytics', icon: i(BarChart3) },
    { to: '/org/profile', label: 'Organization', icon: i(Building2) },
  ],
  ADMIN: [
    { to: '/admin', label: 'Dashboard', icon: i(LayoutDashboard), end: true },
    { to: '/admin/users', label: 'Users', icon: i(Users) },
    { to: '/admin/doctors', label: 'Doctors', icon: i(Stethoscope) },
    { to: '/admin/clinics', label: 'Clinics', icon: i(Building2) },
    { to: '/admin/laboratories', label: 'Laboratories', icon: i(FlaskConical) },
    { to: '/admin/services', label: 'Services', icon: i(TestTubes) },
    { to: '/admin/queues', label: 'Queues', icon: i(ListOrdered) },
    { to: '/admin/reports', label: 'Reports & issues', icon: i(ShieldCheck) },
    { to: '/admin/analytics', label: 'Analytics', icon: i(BarChart3) },
    { to: '/admin/settings', label: 'System settings', icon: i(Settings) },
  ],
};

const roleLabel: Record<Role, string> = { PATIENT: 'Patient', DOCTOR: 'Doctor', ORG_ADMIN: 'Clinic / Lab', ADMIN: 'Administrator' };

/** Listens for pushed notifications: toast, vibration, optional system notification, badge refresh. */
function NotificationListener() {
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    const socket = getSocket();
    const onNew = (n: Notification) => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      const path = window.location.pathname;
      const cardVisible = !!n.data?.queueId && (path === `/queues/${n.data.queueId}` || path === '/patient' || path === '/patient/queues');
      if (!cardVisible) toast({ tone: 'info', title: n.title, body: n.body });
      if (n.type === 'YOUR_TURN' || n.type === 'TURN_APPROACHING') navigator.vibrate?.([200, 100, 200]);
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(n.title, { body: n.body, icon: '/favicon.svg', tag: n.id });
      }
    };
    socket.on('notification:new', onNew);
    return () => {
      socket.off('notification:new', onNew);
    };
  }, [qc, toast]);
  return null;
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              clsx('flex min-h-11 items-center gap-3 rounded-xl px-3 font-medium', isActive ? 'bg-brand-soft text-brand-strong' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')
            }
          >
            {item.icon}
            {item.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function DashboardLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const connected = useSocketConnected();
  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.get<{ unread: number }>('/notifications/unread-count'),
    enabled: !!user,
  });

  useEffect(() => setOpen(false), [location.pathname]);
  if (!user) return null;
  const items = NAV[user.role];

  const signOut = async () => {
    await logout();
    navigate('/');
  };

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <Logo to="/" />
      <nav aria-label="Dashboard">
        <NavList items={items} onNavigate={() => setOpen(false)} />
      </nav>
      <div className="mt-auto rounded-xl bg-surface-2 p-3">
        <p className="truncate font-semibold">{user.fullName}</p>
        <p className="truncate text-sm text-muted">
          {roleLabel[user.role]} · {user.email}
        </p>
        <button onClick={signOut} className="mt-2 flex items-center gap-2 text-sm font-semibold text-st-closed hover:underline">
          <LogOut className="size-4" aria-hidden /> Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[17rem_1fr]">
      <NotificationListener />
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-surface lg:block">{sidebar}</aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-surface">
            <button className="absolute right-3 top-3 rounded-lg p-2 hover:bg-surface-2" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
            {sidebar}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur">
          <div className="flex items-center gap-2">
            <button className="rounded-lg p-2 hover:bg-surface-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
              <Menu className="size-6" />
            </button>
            <span className="lg:hidden">
              <Logo to="/" />
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={clsx('hidden items-center gap-1.5 text-sm sm:flex', connected ? 'text-st-active' : 'text-muted')} aria-live="polite">
              <span className={clsx('size-2 rounded-full', connected ? 'live-dot bg-st-active' : 'bg-muted')} aria-hidden />
              {connected ? 'Live' : 'Connecting…'}
            </span>
            <NavLink to="/notifications" className="relative rounded-lg p-2 hover:bg-surface-2" aria-label={`Notifications${unread?.unread ? `, ${unread.unread} unread` : ''}`}>
              <Bell className="size-6" />
              {!!unread?.unread && (
                <span className="absolute -right-0.5 -top-0.5 grid min-w-5 place-items-center rounded-full bg-st-closed px-1 text-xs font-bold text-white">
                  {unread.unread > 99 ? '99+' : unread.unread}
                </span>
              )}
            </NavLink>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
