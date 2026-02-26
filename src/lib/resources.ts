import { pollResourceMetrics } from "./resource-poller";
import type { ResourceMetrics } from "./resource-poller";
import { getDb, schema } from "../db";
import { sql } from "drizzle-orm";

const SAFETY_BUFFER_MB = 2048;

let latest: ResourceMetrics | null = null;
let lastUpdated = 0;
let interval: Timer | null = null;

function persistPeaks(peaks: ResourceMetrics["completed_peaks"]) {
  if (peaks.length === 0) return;
  const db = getDb();
  for (const p of peaks) {
    db.insert(schema.containerPeaks)
      .values({ name: p.name, peak_mb: p.peak_mb })
      .run();
  }
}

function computeCapacity(freeMb: number): ResourceMetrics["capacity"] {
  const db = getDb();
  const row = db
    .select({
      total: sql<number>`sum(peak_mb)`,
      count: sql<number>`count(*)`,
    })
    .from(schema.containerPeaks)
    .get();

  if (!row || row.count === 0) return null;
  const avg = Math.round(row.total / row.count);
  if (avg <= 0) return null;

  return {
    estimated_remaining: Math.max(0, Math.floor((freeMb - SAFETY_BUFFER_MB) / avg)),
    avg_peak_mb: avg,
  };
}

export function startResourcePoller(intervalMs = 10_000): void {
  if (interval) return;
  const poll = async () => {
    try {
      const raw = await pollResourceMetrics();
      persistPeaks(raw.completed_peaks);
      const freeMb = raw.host.mem_total_mb - raw.host.mem_used_mb;
      latest = { ...raw, capacity: computeCapacity(freeMb) };
      lastUpdated = Date.now();
    } catch {
      // podman may not be available
    }
  };
  poll();
  interval = setInterval(poll, intervalMs);
}

export function getResourceMetrics(): { metrics: ResourceMetrics | null; stale: boolean } {
  return { metrics: latest, stale: !latest || Date.now() - lastUpdated > 30_000 };
}
