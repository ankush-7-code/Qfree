import { z } from 'zod';
import { prisma } from './prisma.js';

/** Platform-wide settings editable by administrators. Stored as key/value rows; defaults apply when unset. */
export const settingsSchema = z.object({
  maxActiveQueuesPerPatient: z.number().int().min(1).max(10),
  enforceOperatingHours: z.boolean(),
  maxUpcomingBookingsPerPatient: z.number().int().min(1).max(20),
  allowJoinWhilePaused: z.boolean(),
  maintenanceMessage: z.string().max(300),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  maxActiveQueuesPerPatient: 3,
  enforceOperatingHours: true,
  maxUpcomingBookingsPerPatient: 5,
  allowJoinWhilePaused: true,
  maintenanceMessage: '',
};

let cache: { value: Settings; at: number } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const rows = await prisma.systemSetting.findMany();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const merged = settingsSchema.parse({ ...DEFAULT_SETTINGS, ...settingsSchema.partial().parse(stored) });
  cache = { value: merged, at: Date.now() };
  return merged;
}

export async function updateSettings(patch: Partial<Settings>) {
  const valid = settingsSchema.partial().parse(patch);
  await prisma.$transaction(
    Object.entries(valid).map(([key, value]) =>
      prisma.systemSetting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } }),
    ),
  );
  cache = null;
  return getSettings();
}
