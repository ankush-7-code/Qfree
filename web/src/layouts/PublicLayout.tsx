import { NavLink, Outlet } from 'react-router';
import clsx from 'clsx';
import { homeFor, useAuth } from '../lib/auth';
import { LinkButton } from '../components/ui/Button';
import { Logo } from './Logo';

const links = [
  { to: '/search', label: 'Find care' },
  { to: '/how-it-works', label: 'How it works' },
  { to: '/about', label: 'About' },
];

export function PublicLayout() {
  const { user } = useAuth();
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Logo />
          <nav aria-label="Main" className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) => clsx('rounded-lg px-3 py-2 font-medium whitespace-nowrap', isActive ? 'bg-brand-soft text-brand-strong' : 'text-ink-2 hover:bg-surface-2')}
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex gap-2">
            {user ? (
              <LinkButton to={homeFor(user.role)}>My dashboard</LinkButton>
            ) : (
              <>
                <LinkButton to="/login" variant="ghost">
                  Sign in
                </LinkButton>
                <LinkButton to="/register">Get started</LinkButton>
              </>
            )}
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-muted">
          <Logo />
          <p>QFree — Know your queue. Save your time.</p>
          <p>© {new Date().getFullYear()} QFree. Patient data is kept to the minimum needed.</p>
        </div>
      </footer>
    </div>
  );
}

/** Page container used by public pages. */
export function Page({ children, narrow }: { children: React.ReactNode; narrow?: boolean }) {
  return <div className={clsx('mx-auto px-4 py-8', narrow ? 'max-w-xl' : 'max-w-6xl')}>{children}</div>;
}
