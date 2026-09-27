import { Link } from 'react-router';

export function Logo({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="flex items-center gap-2 font-extrabold tracking-tight" aria-label="QFree home">
      <svg viewBox="0 0 64 64" className="size-8" aria-hidden>
        <rect width="64" height="64" rx="14" fill="var(--brand)" />
        <path d="M20 22h24M20 32h24M20 42h14" stroke="var(--on-brand)" strokeWidth="5" strokeLinecap="round" />
        <circle cx="45" cy="42" r="5" fill="#5eead4" />
      </svg>
      <span className="text-xl">
        Q<span className="text-brand">Free</span>
      </span>
    </Link>
  );
}
