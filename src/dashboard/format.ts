export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "";
  const s = new Date(start);
  const e = end ? new Date(end) : new Date();
  const diff = Math.max(0, Math.floor((e.getTime() - s.getTime()) / 1000));

  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return `${h}h ${m}m`;
}

export function statusLabel(s: string): string {
  return s.replace("_", " ");
}
