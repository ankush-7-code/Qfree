import { Link } from 'react-router';
import { BellRing, ListOrdered, Mail, Megaphone, Search, ShieldCheck, Smartphone } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from '../../lib/support';
import { LinkButton } from '../../components/ui/Button';
import { Card, EmptyState } from '../../components/ui/primitives';
import { Page } from '../../layouts/PublicLayout';

export function About() {
  return (
    <Page>
      <div className="max-w-3xl">
        <h1 className="text-3xl font-bold sm:text-4xl">About QFreee</h1>
        <p className="mt-4 text-lg text-ink-2">
          Every day, patients spend hours in crowded waiting rooms without knowing where they stand. Elderly patients, parents with sick children and people who
          take time off work all pay for that uncertainty.
        </p>
        <p className="mt-4 text-lg text-ink-2">
          QFreee is a real-time queue system for doctors, clinics, hospitals and laboratories. Patients see the live queue before they travel, join with a
          digital token and follow their position from anywhere. Providers get a simple board to call patients, handle no-shows and emergencies fairly, and
          analytics to reduce waiting over time.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <Card>
            <h2 className="text-lg font-semibold">Our promise to patients</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
              <li>Honest, continuously updated wait estimates</li>
              <li>Strict first-come, first-served order</li>
              <li>Your name is never shown to other patients</li>
              <li>We store only what the queue needs — no medical records</li>
            </ul>
          </Card>
          <Card>
            <h2 className="text-lg font-semibold">Our promise to providers</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
              <li>One tap to call the next patient</li>
              <li>Controlled priority with an audit trail</li>
              <li>Multiple queues per clinic or laboratory</li>
              <li>Clear daily, weekly and monthly insights</li>
            </ul>
          </Card>
        </div>
      </div>
    </Page>
  );
}

const steps = [
  { icon: Search, title: 'Find your doctor or lab', text: 'Search by name, speciality, clinic, test or city. Every provider shows its live queue — who is being served and how long the wait is.' },
  { icon: Smartphone, title: 'Join the queue', text: 'Tap “Join queue” to get a digital token such as QF-031. You can join from home; there is no need to be at the clinic yet.' },
  { icon: ListOrdered, title: 'Watch your place move', text: 'Your screen shows the current token, your token, patients ahead and minutes left. It updates by itself — no refreshing.' },
  { icon: BellRing, title: 'Get a nudge', text: 'When only a few patients are ahead, QFreee alerts you (the screen flashes and your phone vibrates) so you can head over.' },
  { icon: Megaphone, title: 'It’s your turn', text: 'When the doctor calls you, you get a clear “It’s your turn” message. If you miss it, reception can put you back in line.' },
];

export function HowItWorks() {
  return (
    <Page>
      <h1 className="text-3xl font-bold sm:text-4xl">How QFreee works</h1>
      <p className="mt-2 max-w-2xl text-lg text-ink-2">Five simple steps. Designed so that anyone — including first-time smartphone users — understands their status in seconds.</p>
      <ol className="mt-8 grid gap-4">
        {steps.map(({ icon: Icon, title, text }, i) => (
          <li key={title} className="flex gap-4 rounded-2xl border border-line bg-surface p-5">
            <div className="grid size-12 shrink-0 place-items-center rounded-full bg-brand text-xl font-bold text-on-brand">{i + 1}</div>
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Icon className="size-5 text-brand" aria-hidden /> {title}
              </h2>
              <p className="mt-1 text-ink-2">{text}</p>
            </div>
          </li>
        ))}
      </ol>
      <Card className="mt-8">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="size-5 text-brand" aria-hidden /> What the colours mean
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          <li>🟢 <strong>Queue Active</strong> — the doctor is seeing patients</li>
          <li>🟡 <strong>Waiting</strong> — you are in line</li>
          <li>🔵 <strong>Your Turn Approaching</strong> — only a few patients ahead</li>
          <li>🔴 <strong>Queue Closed</strong> — not accepting patients now</li>
        </ul>
      </Card>
      <div className="mt-8">
        <LinkButton to="/search" size="lg">
          Find care now
        </LinkButton>
      </div>
    </Page>
  );
}

export function NotFound() {
  return (
    <Page>
      <EmptyState title="Page not found" action={<LinkButton to="/">Go home</LinkButton>}>
        The page you were looking for does not exist or has moved.
      </EmptyState>
    </Page>
  );
}

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: 'I forgot my password',
    a: (
      <>
        On the sign-in page tap <Link to="/forgot-password" className="font-semibold text-brand hover:underline">Forgot password?</Link>, enter your email and
        follow the link we send you.
      </>
    ),
  },
  { q: 'How do I change my password?', a: 'Sign in and open your Profile (clinics and labs: the Organization page). Use the “Change password” box.' },
  { q: 'How do I sign out?', a: 'Open the menu and tap “Sign out” at the bottom. On a phone, the menu is the ☰ button at the top left.' },
  { q: 'How do I delete my account?', a: 'Sign in, open your Profile (clinics and labs: the Organization page) and use “Delete my account” at the bottom. This cannot be undone.' },
  { q: 'I missed my turn', a: 'Tell the reception desk. They can put you back in the queue according to the clinic’s policy.' },
  { q: 'I run a clinic — how do I add my doctors?', a: 'Sign in with your clinic account and open “Doctors”. You can add, edit, schedule and remove doctors there.' },
];

export function Help() {
  const { user } = useAuth();
  return (
    <Page>
      <div className="max-w-3xl">
        <h1 className="text-3xl font-bold sm:text-4xl">Help &amp; support</h1>
        <p className="mt-2 text-lg text-ink-2">We're here to help patients, doctors, clinics and laboratories.</p>

        <Card className="mt-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Mail className="size-5 text-brand" aria-hidden /> Email us
          </h2>
          <p className="mt-2 text-ink-2">
            Write to{' '}
            <a href={SUPPORT_MAILTO} className="font-semibold text-brand hover:underline">
              {SUPPORT_EMAIL}
            </a>
            . Please include the email or mobile number you signed up with, and for queue problems the clinic name and your token number. We usually reply within 1–2
            working days.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a href={SUPPORT_MAILTO} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand px-4 font-semibold text-on-brand hover:bg-brand-strong">
              <Mail className="size-5" aria-hidden /> Email support
            </a>
            {user && (
              <LinkButton to="/report-issue" variant="secondary">
                Report a problem in the app
              </LinkButton>
            )}
          </div>
        </Card>

        <h2 className="mt-8 text-xl font-semibold">Common questions</h2>
        <div className="mt-3 flex flex-col gap-3">
          {FAQ.map(({ q, a }) => (
            <details key={q} className="rounded-2xl border border-line bg-surface p-4">
              <summary className="cursor-pointer font-semibold">{q}</summary>
              <p className="mt-2 text-ink-2">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </Page>
  );
}
