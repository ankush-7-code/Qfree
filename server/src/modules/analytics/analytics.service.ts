import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export interface AnalyticsRange {
  from: string; // YYYY-MM-DD (inclusive, organization-local session dates)
  to: string;
  bucket: 'day' | 'week' | 'month';
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const round1 = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

/**
 * Aggregates over queue_entries for a set of queues (null = whole platform).
 * Session dates are already organization-local; peak hours are converted per organization timezone.
 */
export async function computeAnalytics(queueIds: string[] | null, range: AnalyticsRange) {
  const scope = queueIds ? Prisma.sql`AND e.queue_id = ANY(${queueIds}::uuid[])` : Prisma.empty;
  const where = Prisma.sql`e.session_date BETWEEN ${range.from} AND ${range.to} ${scope}`;
  const bucket = Prisma.raw(`'${range.bucket}'`); // whitelisted by the route schema

  const [summary] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT
      count(*)                                                   AS total,
      count(*) FILTER (WHERE e.status = 'COMPLETED')             AS served,
      count(*) FILTER (WHERE e.status = 'CANCELLED')             AS cancelled,
      count(*) FILTER (WHERE e.status = 'NO_SHOW')               AS no_show,
      count(*) FILTER (WHERE e.status = 'SKIPPED')               AS skipped,
      count(*) FILTER (WHERE e.priority <> 'NORMAL')             AS prioritized,
      avg(extract(epoch FROM e.called_at - e.joined_at) / 60)
        FILTER (WHERE e.called_at IS NOT NULL)                   AS avg_wait,
      avg(extract(epoch FROM e.completed_at - e.called_at) / 60)
        FILTER (WHERE e.status = 'COMPLETED' AND e.called_at IS NOT NULL) AS avg_consult,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM e.called_at - e.joined_at) / 60)
        FILTER (WHERE e.called_at IS NOT NULL)                   AS p90_wait
    FROM queue_entries e
    WHERE ${where}`;

  const volume = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT to_char(date_trunc(${bucket}, e.session_date::date), 'YYYY-MM-DD') AS period,
           count(*) AS total,
           count(*) FILTER (WHERE e.status = 'COMPLETED') AS served,
           count(*) FILTER (WHERE e.status = 'CANCELLED') AS cancelled,
           count(*) FILTER (WHERE e.status = 'NO_SHOW')   AS no_show,
           avg(extract(epoch FROM e.called_at - e.joined_at) / 60) FILTER (WHERE e.called_at IS NOT NULL) AS avg_wait
    FROM queue_entries e
    WHERE ${where}
    GROUP BY 1 ORDER BY 1`;

  const peak = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT extract(hour FROM (e.joined_at AT TIME ZONE 'UTC') AT TIME ZONE o.timezone)::int AS hour, count(*) AS joins
    FROM queue_entries e
    JOIN queues q ON q.id = e.queue_id
    JOIN organizations o ON o.id = q.organization_id
    WHERE ${where}
    GROUP BY 1 ORDER BY 1`;

  const weekday = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT extract(dow FROM e.session_date::date)::int AS dow, count(*) AS total
    FROM queue_entries e WHERE ${where} GROUP BY 1 ORDER BY 1`;

  const [util] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT avg(s.issued::float / q.capacity) AS utilization
    FROM (
      SELECT e.queue_id, e.session_date, count(*) FILTER (WHERE e.status <> 'CANCELLED') AS issued
      FROM queue_entries e WHERE ${where} GROUP BY 1, 2
    ) s JOIN queues q ON q.id = s.queue_id`;

  const perQueue = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT q.id, q.name, count(*) AS total,
           count(*) FILTER (WHERE e.status = 'COMPLETED') AS served,
           count(*) FILTER (WHERE e.status IN ('CANCELLED', 'NO_SHOW')) AS lost,
           avg(extract(epoch FROM e.called_at - e.joined_at) / 60) FILTER (WHERE e.called_at IS NOT NULL) AS avg_wait,
           avg(extract(epoch FROM e.completed_at - e.called_at) / 60)
             FILTER (WHERE e.status = 'COMPLETED' AND e.called_at IS NOT NULL) AS avg_consult
    FROM queue_entries e JOIN queues q ON q.id = e.queue_id
    WHERE ${where}
    GROUP BY q.id, q.name ORDER BY total DESC LIMIT 25`;

  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, joins: n(peak.find((p) => n(p.hour) === h)?.joins) }));
  const total = n(summary.total);

  return {
    range,
    summary: {
      total,
      served: n(summary.served),
      cancelled: n(summary.cancelled),
      noShow: n(summary.no_show),
      skipped: n(summary.skipped),
      prioritized: n(summary.prioritized),
      avgWaitMinutes: round1(summary.avg_wait),
      p90WaitMinutes: round1(summary.p90_wait),
      avgConsultMinutes: round1(summary.avg_consult),
      completionRate: total ? Math.round((n(summary.served) / total) * 1000) / 10 : null,
      utilizationPercent: util?.utilization === null || util?.utilization === undefined ? null : Math.round(Number(util.utilization) * 1000) / 10,
    },
    volume: volume.map((v) => ({
      period: String(v.period),
      total: n(v.total),
      served: n(v.served),
      cancelled: n(v.cancelled),
      noShow: n(v.no_show),
      avgWaitMinutes: round1(v.avg_wait),
    })),
    peakHours: hours,
    peakHour: total ? hours.reduce((a, b) => (b.joins > a.joins ? b : a)).hour : null,
    weekdays: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dow: d, total: n(weekday.find((w) => n(w.dow) === d)?.total) })),
    perQueue: perQueue.map((q) => ({
      id: String(q.id),
      name: String(q.name),
      total: n(q.total),
      served: n(q.served),
      lost: n(q.lost),
      avgWaitMinutes: round1(q.avg_wait),
      avgConsultMinutes: round1(q.avg_consult),
    })),
  };
}
