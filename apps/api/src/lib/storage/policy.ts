/** Object purpose, not bucket location, determines retention and backup. */
export function isChatObjectKey(key: string): boolean {
  const kind = key.split('/')[1];
  return kind === 'companion' || kind === 'companion-files';
}
export function isPersistentObjectKey(key: string): boolean {
  const parts = key.split('/');
  if (parts[0] === 'avatars') return parts.length === 3;
  if (['notes', 'sources', 'files'].includes(parts[1] ?? '')) return parts.length >= 4;
  return parts[1] === 'imports' && /\.(png|jpe?g|gif|webp)$/i.test(key);
}
/** Fixed Beijing time; independent of the container/host timezone. */
export function backupHours(env: NodeJS.ProcessEnv): [number, number] {
  const start = Number(env.STORAGE_BACKUP_START_HOUR_UTC8 ?? 2), end = Number(env.STORAGE_BACKUP_END_HOUR_UTC8 ?? 6);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) throw new Error('Invalid Beijing backup window');
  return [start, end];
}
export function inNightlyBackupWindow(now = Date.now(), hours: [number, number] = [2, 6]): boolean {
  const hour = new Date(now + 8 * 3600000).getUTCHours();
  return hour >= hours[0] && hour < hours[1];
}
export function replicaCopyMayRun(job: { source: string; operation: string }, now: number, hours?: [number, number]): boolean {
  return job.operation !== 'copy' || job.source === 'backup' || inNightlyBackupWindow(now, hours);
}
