import { Link } from 'react-router';

export function Logo({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="flex items-center" aria-label="QFreee home">
      <img src="/logo.webp" alt="QFreee" width={432} height={144} className="h-11 w-auto" />
    </Link>
  );
}
