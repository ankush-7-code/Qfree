/**
 * Pure queue algorithms (no I/O), unit-tested in tests/queue.logic.test.ts.
 *
 * Ordering:   priority band (EMERGENCY > PRIORITY > NORMAL), then sortKey asc, then token asc.
 * sortKey:    tokenNumber * 1000 on join; the gaps let a skipped patient be re-inserted
 *             a few places down without renumbering everyone.
 * Wait (ETA): patientsAhead * avgServiceSeconds + remaining time of the patient being served.
 * Average:    exponentially-weighted moving average of real consultation durations, with
 *             outlier clamping so a mis-click (5 s) or a forgotten "complete" (3 h) barely moves it.
 */

export type PriorityLevel = 'NORMAL' | 'PRIORITY' | 'EMERGENCY';

export const PRIORITY_RANK: Record<PriorityLevel, number> = { EMERGENCY: 2, PRIORITY: 1, NORMAL: 0 };

export const SORT_KEY_GAP = 1000;
export const REQUEUE_GRACE = 2;
export const MIN_AVG_SECONDS = 60;
export const MAX_AVG_SECONDS = 3600;
export const EWMA_ALPHA = 0.2;

export interface Orderable {
  priority: PriorityLevel;
  sortKey: number;
  tokenNumber: number;
}

export function compareEntries(a: Orderable, b: Orderable): number {
  return (
    PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.sortKey - b.sortKey || a.tokenNumber - b.tokenNumber
  );
}

export function orderWaiting<T extends Orderable>(entries: T[]): T[] {
  return [...entries].sort(compareEntries);
}

export const sortKeyForToken = (tokenNumber: number) => tokenNumber * SORT_KEY_GAP;

export const formatToken = (prefix: string, tokenNumber: number) => `${prefix}-${String(tokenNumber).padStart(3, '0')}`;

/** Remaining seconds for the patient currently being served (never below a small floor while they are inside). */
export function remainingCurrentSeconds(avgServiceSeconds: number, servingSince: Date | null, now: Date): number {
  if (!servingSince) return 0;
  const elapsed = (now.getTime() - servingSince.getTime()) / 1000;
  const floor = Math.min(60, avgServiceSeconds * 0.2);
  return Math.max(avgServiceSeconds - elapsed, floor);
}

export function estimateWaitSeconds(
  patientsAhead: number,
  avgServiceSeconds: number,
  servingSince: Date | null,
  now: Date = new Date(),
): number {
  return Math.round(patientsAhead * avgServiceSeconds + remainingCurrentSeconds(avgServiceSeconds, servingSince, now));
}

export const toMinutes = (seconds: number) => Math.max(0, Math.ceil(seconds / 60));

/** EWMA update of the average service time from one observed consultation. */
export function nextAverage(prevAvgSeconds: number, sampleSeconds: number, alpha = EWMA_ALPHA): number {
  const lower = Math.max(prevAvgSeconds / 3, MIN_AVG_SECONDS / 2);
  const upper = Math.min(prevAvgSeconds * 3, MAX_AVG_SECONDS);
  const clamped = Math.min(Math.max(sampleSeconds, lower), upper);
  const next = prevAvgSeconds * (1 - alpha) + clamped * alpha;
  return Math.round(Math.min(Math.max(next, MIN_AVG_SECONDS), MAX_AVG_SECONDS));
}

/**
 * Sort key that places a re-queued patient after `grace` patients of the same band.
 * Returns null when there is no integer gap left; the caller then renumbers the band
 * (see renumberBand) and asks again.
 */
export function requeueSortKey(bandOrdered: { sortKey: number }[], grace = REQUEUE_GRACE): number | null {
  if (bandOrdered.length === 0) return 0;
  if (bandOrdered.length <= grace) return bandOrdered[bandOrdered.length - 1].sortKey + SORT_KEY_GAP;
  const prev = bandOrdered[grace - 1].sortKey;
  const next = bandOrdered[grace].sortKey;
  if (next - prev < 2) return null;
  return Math.floor((prev + next) / 2);
}

/** Evenly re-space a band's keys (1000, 2000, …). Always stays below keys of future joiners. */
export function renumberBand<T extends { id: string }>(bandOrdered: T[]): { id: string; sortKey: number }[] {
  return bandOrdered.map((e, i) => ({ id: e.id, sortKey: (i + 1) * SORT_KEY_GAP }));
}

export type EntryPhase = 'YOUR_TURN' | 'NEXT' | 'APPROACHING' | 'WAITING' | 'DONE' | 'SKIPPED' | 'CANCELLED' | 'CLOSED';

export function entryPhase(
  status: string,
  patientsAhead: number,
  approachingThreshold: number,
  queueStatus: string,
): EntryPhase {
  switch (status) {
    case 'SERVING':
      return 'YOUR_TURN';
    case 'COMPLETED':
      return 'DONE';
    case 'SKIPPED':
    case 'NO_SHOW':
      return 'SKIPPED';
    case 'CANCELLED':
      return 'CANCELLED';
  }
  if (queueStatus === 'CLOSED') return 'CLOSED';
  if (patientsAhead === 0) return 'NEXT';
  if (patientsAhead <= approachingThreshold) return 'APPROACHING';
  return 'WAITING';
}

/** Share of the line in front of the patient that has already been handled (0..1), for the progress bar. */
export function progressFraction(tokensBefore: number, patientsAhead: number): number {
  if (tokensBefore <= 0) return patientsAhead === 0 ? 1 : 0;
  return Math.min(1, Math.max(0, (tokensBefore - patientsAhead) / tokensBefore));
}
