import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import { api } from '../../lib/api';
import type { Analytics } from '../../lib/types';
import { DAYS_SHORT, hourLabel, hourRange, isoDay, minutes } from '../../lib/format';
import { Card, CardTitle, ErrorState, Spinner, StatCard, Tabs } from '../ui/primitives';

/*
 * Chart conventions (data-viz reference palette, validated for both themes):
 *  - categorical slots 1–3 for served / cancelled / no-show, fixed order, never re-assigned
 *  - single-series charts use slot 1 only; thin bars with 4px rounded data-ends
 *  - hairline solid grid, muted axes, hover tooltip on every chart, table view for each
 */

const AXIS = { stroke: 'var(--chart-axis)', tick: { fill: 'var(--chart-muted)', fontSize: 12 }, tickLine: false } as const;
const GRID = <CartesianGrid stroke="var(--chart-grid)" vertical={false} />;

const SERIES = [
  { key: 'served', label: 'Served', color: 'var(--series-1)' },
  { key: 'cancelled', label: 'Cancelled', color: 'var(--series-2)' },
  { key: 'noShow', label: 'No-show', color: 'var(--series-3)' },
] as const;

function ChartTooltip({ active, payload, label, format }: TooltipContentProps<number, string> & { format?: (label: unknown) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-semibold text-ink">{format ? format(label) : String(label)}</p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} className="flex items-center gap-2 text-ink-2">
          <span className="size-2.5 rounded-sm" style={{ background: p.color }} aria-hidden />
          <span>{p.name}</span>
          <span className="tabular ml-auto pl-4 font-semibold text-ink">{typeof p.value === 'number' ? Math.round(p.value * 10) / 10 : p.value}</span>
        </p>
      ))}
    </div>
  );
}

function Legend({ items }: { items: readonly { label: string; color: string }[] }) {
  return (
    <ul className="mb-3 flex flex-wrap gap-4 text-sm text-ink-2" aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2">
          <span className="size-3 rounded-sm" style={{ background: i.color }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-medium text-brand">Show as table</summary>
      <div className="mt-2 max-h-64 overflow-auto">
        <table className="tabular w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              {head.map((h) => (
                <th key={h} className="py-1 pr-4 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {r.map((c, j) => (
                  <td key={j} className="py-1 pr-4">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ChartCard({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      {note && <p className="-mt-3 mb-3 text-sm text-muted">{note}</p>}
      {children}
    </Card>
  );
}

const RANGES = { '7': 7, '30': 30, '90': 90 } as const;
type RangeKey = keyof typeof RANGES;

const periodLabel = (bucket: string) => (p: unknown) => {
  const d = new Date(`${String(p)}T00:00:00`);
  if (bucket === 'month') return d.toLocaleDateString([], { month: 'short', year: 'numeric' });
  const s = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return bucket === 'week' ? `Week of ${s}` : s;
};

/** Analytics dashboard for any scope: /analytics/doctor, /analytics/organizations/:id, /analytics/platform. */
export function AnalyticsPanel({ endpoint }: { endpoint: string }) {
  const [range, setRange] = useState<RangeKey>('30');
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>('day');
  const from = isoDay(new Date(Date.now() - (RANGES[range] - 1) * 86_400_000));
  const to = isoDay(new Date());

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['analytics', endpoint, from, to, bucket],
    queryFn: () => api.get<Analytics>(endpoint, { from, to, bucket }),
  });

  const filters = (
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <Tabs value={range} onChange={setRange} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      <Tabs value={bucket} onChange={setBucket} options={[{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]} />
    </div>
  );

  if (isLoading) return <>{filters}<Spinner label="Crunching numbers…" /></>;
  if (error || !data) return <>{filters}<ErrorState error={error} retry={refetch} /></>;

  const s = data.summary;
  const fmtPeriod = periodLabel(data.range.bucket);
  const busiest = data.peakHour !== null ? hourRange(data.peakHour) : '—';

  return (
    <div>
      {filters}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Patients served" value={s.served.toLocaleString()} hint={`${s.total.toLocaleString()} tokens issued`} />
        <StatCard label="Average wait" value={minutes(s.avgWaitMinutes)} hint={`90% waited under ${minutes(s.p90WaitMinutes)}`} />
        <StatCard label="Average consultation" value={minutes(s.avgConsultMinutes)} />
        <StatCard label="Busiest hour" value={busiest} />
        <StatCard label="Cancelled" value={s.cancelled.toLocaleString()} hint={s.total ? `${Math.round((s.cancelled / s.total) * 100)}% of tokens` : undefined} />
        <StatCard label="No-shows" value={s.noShow.toLocaleString()} hint={s.total ? `${Math.round((s.noShow / s.total) * 100)}% of tokens` : undefined} />
        <StatCard label="Completion rate" value={s.completionRate === null ? '—' : `${s.completionRate}%`} />
        <StatCard label="Queue utilization" value={s.utilizationPercent === null ? '—' : `${s.utilizationPercent}%`} hint="Tokens issued vs. daily capacity" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <ChartCard title="Patient volume">
          <Legend items={SERIES} />
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={data.volume} margin={{ top: 4, right: 8, left: -12, bottom: 0 }} barCategoryGap="25%">
                {GRID}
                <XAxis dataKey="period" {...AXIS} tickFormatter={(p) => fmtPeriod(p).replace('Week of ', '')} minTickGap={16} />
                <YAxis {...AXIS} axisLine={false} allowDecimals={false} />
                <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={(p) => <ChartTooltip {...(p as TooltipContentProps<number, string>)} format={fmtPeriod} />} />
                {SERIES.map((ser, i) => (
                  <Bar
                    key={ser.key}
                    dataKey={ser.key}
                    name={ser.label}
                    stackId="v"
                    fill={ser.color}
                    stroke="var(--surface)"
                    strokeWidth={2}
                    radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : 0}
                    maxBarSize={28}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <DataTable head={['Period', 'Served', 'Cancelled', 'No-show', 'Total']} rows={data.volume.map((v) => [fmtPeriod(v.period), v.served, v.cancelled, v.noShow, v.total])} />
        </ChartCard>

        <ChartCard title="Average waiting time" note="Minutes from joining the queue to being called">
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={data.volume} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                {GRID}
                <XAxis dataKey="period" {...AXIS} tickFormatter={(p) => fmtPeriod(p).replace('Week of ', '')} minTickGap={16} />
                <YAxis {...AXIS} axisLine={false} unit=" m" />
                <Tooltip cursor={{ stroke: 'var(--chart-axis)' }} content={(p) => <ChartTooltip {...(p as TooltipContentProps<number, string>)} format={fmtPeriod} />} />
                <Line type="monotone" dataKey="avgWaitMinutes" name="Avg wait (min)" stroke="var(--series-1)" strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <DataTable head={['Period', 'Avg wait (min)']} rows={data.volume.map((v) => [fmtPeriod(v.period), v.avgWaitMinutes ?? '—'])} />
        </ChartCard>

        <ChartCard title="Peak hours" note="When patients join queues (local time)">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={data.peakHours.filter((h) => h.hour >= 6 && h.hour <= 23)} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                {GRID}
                <XAxis dataKey="hour" {...AXIS} tickFormatter={hourLabel} interval={2} />
                <YAxis {...AXIS} axisLine={false} allowDecimals={false} />
                <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={(p) => <ChartTooltip {...(p as TooltipContentProps<number, string>)} format={(h) => `${hourLabel(Number(h))}–${hourLabel((Number(h) + 1) % 24)}`} />} />
                <Bar dataKey="joins" name="Patients joined" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <DataTable head={['Hour', 'Patients joined']} rows={data.peakHours.map((h) => [hourLabel(h.hour), h.joins])} />
        </ChartCard>

        <ChartCard title="Busiest days of the week">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={data.weekdays} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                {GRID}
                <XAxis dataKey="dow" {...AXIS} tickFormatter={(d) => DAYS_SHORT[d]} />
                <YAxis {...AXIS} axisLine={false} allowDecimals={false} />
                <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={(p) => <ChartTooltip {...(p as TooltipContentProps<number, string>)} format={(d) => DAYS_SHORT[Number(d)]} />} />
                <Bar dataKey="total" name="Tokens issued" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <DataTable head={['Day', 'Tokens']} rows={data.weekdays.map((w) => [DAYS_SHORT[w.dow], w.total])} />
        </ChartCard>
      </div>

      {data.perQueue.length > 1 && (
        <Card className="mt-5">
          <CardTitle>By queue</CardTitle>
          <div className="-mx-5 overflow-x-auto">
            <table className="tabular w-full min-w-[560px] text-left">
              <thead>
                <tr className="border-b border-line text-sm text-muted">
                  {['Queue', 'Tokens', 'Served', 'Cancelled / no-show', 'Avg wait', 'Avg consult'].map((h) => (
                    <th key={h} className="px-5 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.perQueue.map((q) => (
                  <tr key={q.id}>
                    <td className="px-5 py-2.5 font-medium">{q.name}</td>
                    <td className="px-5 py-2.5">{q.total}</td>
                    <td className="px-5 py-2.5">{q.served}</td>
                    <td className="px-5 py-2.5">{q.lost}</td>
                    <td className="px-5 py-2.5">{minutes(q.avgWaitMinutes)}</td>
                    <td className="px-5 py-2.5">{minutes(q.avgConsultMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
