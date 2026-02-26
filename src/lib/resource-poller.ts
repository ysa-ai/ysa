export interface ContainerMetrics {
  name: string;
  cpu_pct: number;
  mem_mb: number;
  pids: number;
}

export interface ContainerPeak {
  name: string;
  peak_mb: number;
}

export interface ResourceMetrics {
  containers: ContainerMetrics[];
  aggregate: { count: number; total_cpu_pct: number; total_mem_mb: number };
  host: { cpu_pct: number; mem_used_mb: number; mem_total_mb: number; mem_pct: number; disk_free_gb: number };
  capacity: { estimated_remaining: number; avg_peak_mb: number } | null;
  completed_peaks: ContainerPeak[];
  warnings: string[];
}

const WARN_MEM_PCT = 85;
const WARN_DISK_GB = 5;

const isDarwin = process.platform === "darwin";

// Per-container peak tracking (in-memory while running)
const peakByContainer = new Map<string, number>();
let previousNames = new Set<string>();


async function exec(cmd: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function getContainerNames(): Promise<string[]> {
  const raw = await exec("podman ps --format '{{.Names}}' 2>/dev/null");
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((n) => n.startsWith("sandbox-") || n.startsWith("bench-"));
}

async function getContainerStats(names: string[]): Promise<ContainerMetrics[]> {
  if (names.length === 0) return [];
  const raw = await exec(
    `podman stats --no-stream --format '{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.PIDs}}' ${names.join(" ")} 2>/dev/null`,
  );
  if (!raw) return [];

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, cpuRaw, memRaw, pidsRaw] = line.split("\t");
      const cpu_pct = parseFloat(cpuRaw?.replace("%", "") || "0") || 0;
      const pids = parseInt(pidsRaw?.trim() || "0", 10) || 0;

      let mem_mb = 0;
      if (memRaw) {
        const match = memRaw.match(/([\d.]+)\s*(GiB|GB|MiB|MB|KiB|KB)/i);
        if (match) {
          const val = parseFloat(match[1]);
          const unit = match[2].toLowerCase();
          if (unit.startsWith("g")) mem_mb = Math.round(val * 1024);
          else if (unit.startsWith("k")) mem_mb = Math.round(val / 1024);
          else mem_mb = Math.round(val);
        }
      }

      return { name, cpu_pct, mem_mb, pids };
    });
}

async function getHostCpuPct(): Promise<number> {
  if (isDarwin) {
    const raw = await exec("top -l 1 -s 0 2>/dev/null | head -4");
    const match = raw.match(/CPU usage:\s+([\d.]+)%\s+user,\s+([\d.]+)%\s+sys/);
    if (match) return Math.round((parseFloat(match[1]) + parseFloat(match[2])) * 10) / 10;
    return 0;
  }
  const snap = async () => {
    const raw = await exec("head -1 /proc/stat 2>/dev/null");
    const parts = raw.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] ?? 0;
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  };
  const s1 = await snap();
  await new Promise((r) => setTimeout(r, 200));
  const s2 = await snap();
  const dTotal = s2.total - s1.total;
  const dIdle = s2.idle - s1.idle;
  if (dTotal === 0) return 0;
  return Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10;
}

async function getHostMemory(): Promise<{ used_mb: number; total_mb: number }> {
  if (isDarwin) {
    const [vmRaw, totalRaw] = await Promise.all([
      exec("vm_stat"),
      exec("sysctl -n hw.memsize"),
    ]);
    const total_mb = Math.round(parseInt(totalRaw, 10) / 1024 / 1024);

    const pageSize = parseInt(vmRaw.match(/page size of (\d+)/)?.[1] || "16384", 10);
    const get = (label: string) => {
      const m = vmRaw.match(new RegExp(`${label}:\\s+(\\d+)`));
      return parseInt(m?.[1] || "0", 10);
    };
    const active = get("Pages active");
    const wired = get("Pages wired down");
    const compressed = get("Pages occupied by compressor");
    const used_mb = Math.round(((active + wired + compressed) * pageSize) / 1024 / 1024);

    return { used_mb, total_mb };
  }

  const raw = await exec("free -m 2>/dev/null");
  const match = raw.match(/^Mem:\s+(\d+)\s+(\d+)/m);
  if (!match) return { used_mb: 0, total_mb: 0 };
  return { used_mb: parseInt(match[2], 10), total_mb: parseInt(match[1], 10) };
}

async function getDiskFreeGb(): Promise<number> {
  const home = process.env.HOME || "/";
  if (isDarwin) {
    const raw = await exec(`df -g "${home}" 2>/dev/null`);
    const match = raw.match(/\n\S+\s+\d+\s+\d+\s+(\d+)/);
    return parseInt(match?.[1] || "0", 10);
  }
  const raw = await exec(`df -BG "${home}" 2>/dev/null`);
  const match = raw.match(/\n\S+\s+\S+\s+\S+\s+(\d+)G/);
  return parseInt(match?.[1] || "0", 10);
}

export async function pollResourceMetrics(): Promise<Omit<ResourceMetrics, "capacity">> {
  const [names, hostCpu, hostMem, diskFreeGb] = await Promise.all([
    getContainerNames(),
    getHostCpuPct(),
    getHostMemory(),
    getDiskFreeGb(),
  ]);

  const containers = await getContainerStats(names);
  const currentNames = new Set(names);

  // Update peaks for running containers
  for (const c of containers) {
    const prev = peakByContainer.get(c.name) ?? 0;
    if (c.mem_mb > prev) peakByContainer.set(c.name, c.mem_mb);
  }

  // Detect removed containers → collect their peaks
  const completed_peaks: ContainerPeak[] = [];
  for (const name of previousNames) {
    if (!currentNames.has(name)) {
      const peak = peakByContainer.get(name);
      if (peak && peak > 0) {
        completed_peaks.push({ name, peak_mb: peak });
      }
      peakByContainer.delete(name);
    }
  }
  previousNames = currentNames;

  const aggregate = {
    count: containers.length,
    total_cpu_pct: Math.round(containers.reduce((s, c) => s + c.cpu_pct, 0) * 10) / 10,
    total_mem_mb: containers.reduce((s, c) => s + c.mem_mb, 0),
  };

  const mem_pct = hostMem.total_mb > 0
    ? Math.round((hostMem.used_mb * 100) / hostMem.total_mb)
    : 0;

  const host = {
    cpu_pct: hostCpu,
    mem_used_mb: hostMem.used_mb,
    mem_total_mb: hostMem.total_mb,
    mem_pct,
    disk_free_gb: diskFreeGb,
  };

  const warnings: string[] = [];
  if (mem_pct >= WARN_MEM_PCT) warnings.push("memory_high");
  if (diskFreeGb < WARN_DISK_GB) warnings.push("disk_low");

  return { containers, aggregate, host, completed_peaks, warnings };
}
