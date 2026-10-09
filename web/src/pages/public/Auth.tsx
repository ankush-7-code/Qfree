import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { errorMessage } from '../../lib/api';
import { homeFor, useAuth, type RegisterInput } from '../../lib/auth';
import { Button } from '../../components/ui/Button';
import { Alert, Card, Input, Select, Tabs } from '../../components/ui/primitives';
import { Page } from '../../layouts/PublicLayout';

const DEMO = [
  { label: 'Patient', email: 'patient@qfree.dev' },
  { label: 'Doctor', email: 'dr.sharma@qfree.dev' },
  { label: 'Clinic', email: 'clinic@qfree.dev' },
];

/** Only allow in-app redirects after login (prevents open redirects). */
const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : null);

export function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={safeNext(params.get('next')) ?? homeFor(user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await login(email, password);
      navigate(safeNext(params.get('next')) ?? homeFor(me.role), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page narrow>
      <Card className="p-6 sm:p-8">
        <h1 className="text-2xl font-bold">Welcome back</h1>
        <p className="mt-1 text-ink-2">Sign in to see your queue.</p>
        <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
          {error && <Alert>{error}</Alert>}
          <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" size="lg" loading={busy}>
            Sign in
          </Button>
        </form>
        <p className="mt-6 text-center text-ink-2">
          New to QFree?{' '}
          <Link to="/register" className="font-semibold text-brand hover:underline">
            Create an account
          </Link>
        </p>
        {/* Quick demo logins only when developing locally; never shown on the live website. */}
        {import.meta.env.DEV && (
          <div className="mt-6 rounded-xl bg-surface-2 p-4 text-sm">
            <p className="font-semibold">Demo accounts (password: Password123) — local development only</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {DEMO.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  className="rounded-lg border border-line bg-surface px-3 py-1.5 font-medium hover:border-brand"
                  onClick={() => {
                    setEmail(d.email);
                    setPassword('Password123');
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>
    </Page>
  );
}

type Kind = 'PATIENT' | 'DOCTOR' | 'ORG_ADMIN';

export function Register() {
  const { register, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initial = (['PATIENT', 'DOCTOR', 'ORG_ADMIN'] as Kind[]).find((r) => r === params.get('role')) ?? 'PATIENT';
  const [role, setRole] = useState<Kind>(initial);
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', password: '', specialization: '', qualification: '', experienceYears: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={homeFor(user.role)} replace />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input: RegisterInput = {
      email: form.email,
      password: form.password,
      fullName: form.fullName,
      phone: form.phone || undefined,
      role,
      ...(role === 'DOCTOR'
        ? { doctor: { specialization: form.specialization, qualification: form.qualification || undefined, experienceYears: form.experienceYears ? Number(form.experienceYears) : undefined } }
        : {}),
    };
    try {
      const me = await register(input);
      navigate(me.role === 'ORG_ADMIN' ? '/org/setup' : safeNext(params.get('next')) ?? homeFor(me.role), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page narrow>
      <Card className="p-6 sm:p-8">
        <h1 className="text-2xl font-bold">Create your QFree account</h1>
        <p className="mt-1 text-ink-2">We only ask for what we need to manage your place in the queue.</p>
        <div className="mt-5">
          <Tabs value={role} onChange={setRole} options={[{ value: 'PATIENT', label: 'Patient' }, { value: 'DOCTOR', label: 'Doctor' }, { value: 'ORG_ADMIN', label: 'Clinic / Lab' }]} />
        </div>
        <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
          {error && <Alert>{error}</Alert>}
          <Input label="Full name" autoComplete="name" required minLength={2} value={form.fullName} onChange={set('fullName')} />
          <Input label="Email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
          <Input label="Mobile number (optional)" type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} hint="Used by clinic staff if they need to reach you." />
          <Input
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={form.password}
            onChange={set('password')}
            hint="At least 8 characters, including a letter and a number."
          />
          {role === 'DOCTOR' && (
            <>
              <Input label="Specialization" required value={form.specialization} onChange={set('specialization')} placeholder="e.g. General Physician" />
              <Input label="Qualification (optional)" value={form.qualification} onChange={set('qualification')} placeholder="e.g. MBBS, MD" />
              <Select label="Years of experience" value={form.experienceYears} onChange={set('experienceYears')}>
                <option value="">Prefer not to say</option>
                {[1, 2, 3, 5, 8, 10, 15, 20, 25, 30].map((y) => (
                  <option key={y} value={y}>
                    {y}+
                  </option>
                ))}
              </Select>
            </>
          )}
          {role === 'ORG_ADMIN' && <p className="text-ink-2">After signing up you'll set up your clinic or laboratory profile.</p>}
          <Button type="submit" size="lg" loading={busy}>
            Create account
          </Button>
        </form>
        <p className="mt-6 text-center text-ink-2">
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-brand hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    </Page>
  );
}
