import { Link } from 'react-router';
import { BarChart3, BellRing, Clock, FlaskConical, Hospital, Search, ShieldCheck, Smartphone, Stethoscope, Users } from 'lucide-react';
import { LinkButton } from '../../components/ui/Button';
import { Indicator } from '../../components/queue/Status';
import { LiveShowcase } from '../../components/queue/LiveShowcase';
import { PlayCircle, Hourglass } from 'lucide-react';

/** Illustrative preview of the live queue card (static sample data). */
function PreviewCard() {
  const rows: [string, string, boolean?][] = [
    ['Current token', 'QF-024'],
    ['Your token', 'QF-031', true],
    ['Patients ahead', '6'],
    ['Estimated wait', '35 min'],
  ];
  return (
    <div className="w-full max-w-sm overflow-hidden rounded-3xl border-2 border-line bg-surface shadow-xl" aria-label="Example of the live queue screen">
      <div className="flex items-center justify-between bg-brand px-5 py-3 text-on-brand">
        <span className="font-semibold">QFree — Live Queue</span>
        <span className="flex items-center gap-1.5 text-sm">
          <span className="live-dot size-2 rounded-full bg-current" /> Live
        </span>
      </div>
      <div className="p-5">
        <p className="text-xl font-bold">Dr. Sharma</p>
        <p className="text-ink-2">General Physician</p>
        <dl className="mt-3">
          {rows.map(([k, v, strong]) => (
            <div key={k} className="flex items-baseline justify-between border-b border-line py-2.5 last:border-0">
              <dt className="text-ink-2">{k}</dt>
              <dd className={strong ? 'tabular text-3xl font-bold text-brand' : 'tabular text-2xl font-bold'}>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 h-4 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-[68%] rounded-full bg-brand" />
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Indicator tone="active" icon={<PlayCircle />} live>
            Queue Active
          </Indicator>
          <Indicator tone="waiting" icon={<Hourglass />}>
            Waiting
          </Indicator>
        </div>
      </div>
    </div>
  );
}

const features = [
  { icon: Search, title: 'Check before you leave home', text: 'See how many people are waiting and the expected wait for any doctor, clinic or lab.' },
  { icon: Smartphone, title: 'Join from your phone', text: 'Get a digital token in one tap. No paper slips, no crowded waiting rooms.' },
  { icon: Clock, title: 'Live position and wait time', text: 'Your place in line and minutes remaining update by themselves, second by second.' },
  { icon: BellRing, title: 'A nudge when it is nearly your turn', text: 'We alert you when a few patients are left, and again when you are called.' },
];

const providers = [
  { icon: Stethoscope, title: 'Doctors', text: 'Call the next patient with one tap, handle no-shows and emergencies, see daily stats.' },
  { icon: Hospital, title: 'Clinics & hospitals', text: 'Run many queues at once, manage doctors, staff and opening hours from one dashboard.' },
  { icon: FlaskConical, title: 'Laboratories', text: 'Separate queues for sample collection, X-ray or ultrasound with realistic wait estimates.' },
];

export function Landing() {
  return (
    <>
      <section className="bg-gradient-to-b from-brand-soft to-bg">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 md:grid-cols-[1.1fr_1fr] md:py-20">
          <div>
            <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-sm font-semibold text-brand-strong">
              <span className="live-dot size-2 rounded-full bg-st-active" /> Real-time healthcare queues
            </p>
            <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
              Know your queue.
              <br />
              <span className="text-brand">Save your time.</span>
            </h1>
            <p className="mt-4 max-w-xl text-lg text-ink-2">
              QFree shows you exactly where you are in line at your doctor, clinic or laboratory — and how long until it's your turn. Wait at home, at work or at a café, not in a crowded room.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton to="/search" size="lg" icon={<Search className="size-5" />}>
                Find a doctor or lab
              </LinkButton>
              <LinkButton to="/register?role=ORG_ADMIN" size="lg" variant="secondary">
                I run a clinic
              </LinkButton>
            </div>
          </div>
          <div className="flex justify-center">
            <LiveShowcase fallback={<PreviewCard />} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-center text-3xl font-bold">Patient → Queue → Provider</h2>
        <p className="mx-auto mt-2 max-w-2xl text-center text-ink-2">
          You join and receive <strong>QF-031</strong>. The doctor serves QF-024, QF-025 … and as your turn nears, QFree lets you know.
        </p>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-2xl border border-line bg-surface p-5">
              <Icon className="size-8 text-brand" aria-hidden />
              <h3 className="mt-3 text-lg font-semibold">{title}</h3>
              <p className="mt-1 text-ink-2">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-3xl font-bold">Built for healthcare teams</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {providers.map(({ icon: Icon, title, text }) => (
              <div key={title} className="flex gap-4">
                <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-strong">
                  <Icon className="size-6" aria-hidden />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">{title}</h3>
                  <p className="text-ink-2">{text}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {[
              { icon: Users, t: 'Fair by design', d: 'Strict token order. Priority only for emergencies, set by staff with a recorded reason.' },
              { icon: BarChart3, t: 'Insightful', d: 'Waiting times, consultation times, no-shows and peak hours at a glance.' },
              { icon: ShieldCheck, t: 'Private', d: 'Other patients never see your name — only token numbers are public.' },
            ].map(({ icon: Icon, t, d }) => (
              <div key={t} className="rounded-2xl bg-surface-2 p-5">
                <Icon className="size-6 text-brand" aria-hidden />
                <p className="mt-2 font-semibold">{t}</p>
                <p className="text-ink-2">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14 text-center">
        <h2 className="text-3xl font-bold">Ready to stop waiting?</h2>
        <p className="mt-2 text-ink-2">Free for patients. Takes less than a minute.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <LinkButton to="/register" size="lg">
            Create free account
          </LinkButton>
          <Link to="/how-it-works" className="min-h-13 rounded-xl px-6 py-3 text-lg font-semibold text-brand hover:bg-brand-soft">
            See how it works
          </Link>
        </div>
      </section>
    </>
  );
}
