import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { getSocket, onConnectionChange, watch } from '../lib/socket';
import type { EntryView, QueueSnapshot, StaffView } from '../lib/types';

interface QueueStatus {
  snapshot: QueueSnapshot;
  myEntry: EntryView | null;
}

export const queueKey = (id: string) => ['queue', id, 'status'] as const;
export const staffKey = (id: string) => ['queue', id, 'staff'] as const;

/**
 * Public queue status + the signed-in patient's own entry, kept live over Socket.IO.
 * REST provides the first paint; socket events then patch the cache in place.
 */
export function useQueueLive(queueId: string | undefined) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: queueKey(queueId ?? ''),
    queryFn: () => api.get<QueueStatus>(`/queues/${queueId}/status`),
    enabled: !!queueId,
    // Safety net if the socket is blocked (e.g. restrictive networks): slow background poll.
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!queueId) return;
    const socket = getSocket();
    const onSnapshot = (snapshot: QueueSnapshot) => {
      if (snapshot.id !== queueId) return;
      qc.setQueryData<QueueStatus>(queueKey(queueId), (old) => ({ snapshot, myEntry: old?.myEntry ?? null }));
    };
    const onEntry = (entry: EntryView) => {
      if (entry.queueId !== queueId) return;
      qc.setQueryData<QueueStatus>(queueKey(queueId), (old) => (old ? { ...old, myEntry: entry } : old));
      qc.invalidateQueries({ queryKey: ['patient', 'queues'] });
    };
    socket.on('queue:snapshot', onSnapshot);
    socket.on('queue:entry', onEntry);
    const unwatch = watch('queue:watch', queueId);
    return () => {
      socket.off('queue:snapshot', onSnapshot);
      socket.off('queue:entry', onEntry);
      unwatch();
    };
  }, [queueId, qc]);

  return query;
}

/** Full staff view of a queue (doctor / organization / admin), kept live. */
export function useStaffQueue(queueId: string | undefined) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: staffKey(queueId ?? ''),
    queryFn: () => api.get<StaffView>(`/queues/${queueId}/staff`),
    enabled: !!queueId,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!queueId) return;
    const socket = getSocket();
    const onStaff = (view: StaffView) => {
      if (view.snapshot.id === queueId) qc.setQueryData(staffKey(queueId), view);
    };
    socket.on('queue:staff', onStaff);
    const unwatch = watch('queue:watch-staff', queueId);
    return () => {
      socket.off('queue:staff', onStaff);
      unwatch();
    };
  }, [queueId, qc]);

  return query;
}

/** Keeps a list of queue snapshots (e.g. an organization dashboard) live. */
export function useLiveSnapshots(queryKey: readonly unknown[], ids: string[]) {
  const qc = useQueryClient();
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    const socket = getSocket();
    const set = new Set(key.split(','));
    const onSnapshot = (snap: QueueSnapshot) => {
      if (!set.has(snap.id)) return;
      qc.setQueriesData({ queryKey }, (old: unknown) => replaceSnapshot(old, snap));
    };
    socket.on('queue:snapshot', onSnapshot);
    const unwatchers = [...set].map((id) => watch('queue:watch', id));
    return () => {
      socket.off('queue:snapshot', onSnapshot);
      unwatchers.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, qc]);
}

/** Replace a snapshot with the same id anywhere inside a cached response. */
function replaceSnapshot(value: unknown, snap: QueueSnapshot): unknown {
  if (Array.isArray(value)) return value.map((v) => replaceSnapshot(v, snap));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.id === snap.id && 'tokenPrefix' in obj && 'waitingCount' in obj) return snap;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const nv = replaceSnapshot(v, snap);
      if (nv !== v) changed = true;
      out[k] = nv;
    }
    return changed ? out : value;
  }
  return value;
}

export function useSocketConnected() {
  const [connected, setConnected] = useState(() => getSocket().connected);
  useEffect(() => onConnectionChange(setConnected), []);
  return connected;
}
