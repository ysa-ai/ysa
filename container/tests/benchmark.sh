#!/bin/bash
# benchmark.sh — Measure resource consumption of parallel sandboxed containers
#
# Usage: bash packages/core/container/benchmark.sh [--containers N] [--duration S] [--output FILE] [--keep]
#
# Launches N hardened containers with a synthetic workload (git ops, file I/O,
# CPU bursts, memory growth) and reports CPU, memory, disk, and PID metrics.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="sandbox-claude"
SECCOMP_PROFILE="$SCRIPT_DIR/../seccomp.json"

# ── Defaults ─────────────────────────────────────────────────────────
NUM_CONTAINERS=5
DURATION=30
OUTPUT_FILE=""
KEEP=false

# ── Parse args ───────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --containers) NUM_CONTAINERS="$2"; shift 2 ;;
    --duration)   DURATION="$2"; shift 2 ;;
    --output)     OUTPUT_FILE="$2"; shift 2 ;;
    --keep)       KEEP=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--containers N] [--duration S] [--output FILE] [--keep]"
      echo ""
      echo "  --containers  Number of parallel containers (default: 5, max: 10)"
      echo "  --duration    Synthetic task duration in seconds (default: 30)"
      echo "  --output      Write JSON report to FILE"
      echo "  --keep        Skip cleanup (for manual inspection)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$NUM_CONTAINERS" -gt 10 ]; then
  echo "ERROR: --containers max is 10 (got $NUM_CONTAINERS)" >&2
  exit 1
fi
if [ "$NUM_CONTAINERS" -lt 1 ]; then
  echo "ERROR: --containers must be >= 1" >&2
  exit 1
fi

# ── Helper: container name from 1-based index ───────────────────────
cname() { printf "bench-%03d" "$1"; }

# ── Temp files & cleanup ─────────────────────────────────────────────
WORKSPACE="$HOME/.cache/sandbox-benchmark-workspace"
STATS_FILE=$(mktemp /tmp/bench-stats.XXXXXX)
# BENCH_TMPDIR must be under $HOME — macOS /tmp is a symlink to /private/tmp
# which Podman VM can't resolve for bind mounts
BENCH_TMPDIR="$HOME/.cache/sandbox-benchmark-tmp"
rm -rf "$BENCH_TMPDIR"
mkdir -p "$BENCH_TMPDIR"
LAUNCHED=0  # how many containers were actually launched

cleanup() {
  echo ""
  if [ "$KEEP" = true ]; then
    echo "Skipping cleanup (--keep). Resources to inspect:"
    echo "  Workspace: $WORKSPACE"
    echo "  Worktrees: $WORKSPACE-worktrees/"
    echo "  Stats file: $STATS_FILE"
    return
  fi
  echo "Cleaning up..."
  for i in $(seq 1 "$NUM_CONTAINERS"); do
    name=$(cname "$i")
    podman stop "$name" 2>/dev/null || true
    podman rm -f "$name" 2>/dev/null || true
    podman volume rm "benchmark-session-$name" 2>/dev/null || true
    if [ -d "$WORKSPACE" ]; then
      git -C "$WORKSPACE" worktree remove --force "$WORKSPACE-worktrees/$name" 2>/dev/null || true
    fi
  done
  rm -rf "$WORKSPACE" "$WORKSPACE-worktrees" 2>/dev/null || true
  rm -f "$STATS_FILE"
  rm -rf "$BENCH_TMPDIR"
}
trap cleanup EXIT

# ── Preflight ────────────────────────────────────────────────────────
echo "=========================================="
echo " SANDBOX RESOURCE BENCHMARK"
echo " Containers: $NUM_CONTAINERS  |  Duration: ${DURATION}s each"
echo "=========================================="
echo ""
echo "--- Preflight ---"

fail_preflight() { echo "  [FAIL] $1" >&2; exit 1; }
ok_preflight()   { echo "  [OK]   $1"; }

if ! command -v podman >/dev/null 2>&1; then
  fail_preflight "Podman not installed"
fi
ok_preflight "Podman installed"

rootless=$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null || echo "false")
if [ "$rootless" != "true" ]; then
  fail_preflight "Podman is not in rootless mode"
fi
ok_preflight "Rootless mode"

if ! podman image exists "$IMAGE" 2>/dev/null; then
  fail_preflight "Image '$IMAGE' not found — build it first"
fi
ok_preflight "Image '$IMAGE' exists"

if [ ! -f "$SECCOMP_PROFILE" ]; then
  fail_preflight "Seccomp profile not found: $SECCOMP_PROFILE"
fi
ok_preflight "Seccomp profile present"

# ── Baseline ─────────────────────────────────────────────────────────
echo ""
echo "--- Baseline ---"

get_host_mem_mb() {
  if [ "$(uname)" = "Darwin" ]; then
    local ps ap wp cp up
    ps=$(vm_stat | head -1 | grep -oE '[0-9]+')
    ap=$(vm_stat | awk '/Pages active:/ {gsub(/\./,"",$(NF)); print $(NF)}')
    wp=$(vm_stat | awk '/Pages wired down:/ {gsub(/\./,"",$(NF)); print $(NF)}')
    cp=$(vm_stat | awk '/Pages occupied by compressor:/ {gsub(/\./,"",$(NF)); print $(NF)}')
    up=$(( ${ap:-0} + ${wp:-0} + ${cp:-0} ))
    echo $(( up * ${ps:-16384} / 1024 / 1024 ))
  else
    free -m 2>/dev/null | awk '/^Mem:/ {print $3}' || echo 0
  fi
}

if [ "$(uname)" = "Darwin" ]; then
  TOTAL_MEM_MB=$(( $(sysctl -n hw.memsize 2>/dev/null) / 1024 / 1024 ))
else
  TOTAL_MEM_MB=$(free -m 2>/dev/null | awk '/^Mem:/ {print $2}' || echo 0)
fi

BASELINE_MEM_MB=$(get_host_mem_mb)
PODMAN_STORAGE=$(podman system info --format '{{.Store.GraphRoot}}' 2>/dev/null || echo "/var/lib/containers")
DISK_BEFORE=$(du -sm "$PODMAN_STORAGE" 2>/dev/null | awk '{print $1}' || echo 0)

echo "  Host memory used:    ${BASELINE_MEM_MB} MB / ${TOTAL_MEM_MB} MB"
echo "  Podman storage:      ${DISK_BEFORE} MB"

# ── Setup temp git repo ──────────────────────────────────────────────
echo ""
echo "--- Setup Workspace ---"

rm -rf "$WORKSPACE" "$WORKSPACE-worktrees"
mkdir -p "$WORKSPACE"
git init "$WORKSPACE" --quiet
git -C "$WORKSPACE" commit --allow-empty -m "init" --quiet

cat > "$WORKSPACE/package.json" <<'PROJEOF'
{
  "name": "benchmark-project",
  "version": "1.0.0",
  "scripts": { "build": "echo build", "test": "echo test" }
}
PROJEOF

mkdir -p "$WORKSPACE/src"
cat > "$WORKSPACE/src/index.ts" <<'SRCEOF'
export function processData(input: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of input) {
    result[item] = (result[item] || 0) + 1;
  }
  return result;
}

export function formatOutput(data: Record<string, number>): string {
  return Object.entries(data)
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => `${key}: ${count}`)
    .join('\n');
}
SRCEOF

cat > "$WORKSPACE/README.md" <<'RDMEOF'
# Benchmark Project
Synthetic project for container resource benchmarking.
RDMEOF

git -C "$WORKSPACE" add -A && git -C "$WORKSPACE" commit -m "initial project setup" --quiet
echo "  Workspace: $WORKSPACE"

# ── Create worktrees ─────────────────────────────────────────────────
echo ""
echo "--- Worktree Creation ---"

# Indexed arrays: WT_TIMES[i], WT_SIZES[i] (0-based)
WT_TIMES=()
WT_SIZES=()

for i in $(seq 1 "$NUM_CONTAINERS"); do
  name=$(cname "$i")
  branch="bench/$name"
  wt_path="$WORKSPACE-worktrees/$name"

  start_time=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
  git -C "$WORKSPACE" branch "$branch" 2>/dev/null || true
  git -C "$WORKSPACE" worktree add "$wt_path" "$branch" --quiet 2>/dev/null
  # Make worktree a standalone repo — the .git file points to a host path
  # that won't exist inside the container
  rm -f "$wt_path/.git"
  git init "$wt_path" --quiet
  git -C "$wt_path" add -A && git -C "$wt_path" commit -m "init" --quiet
  end_time=$(date +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')

  elapsed_ms=$(( (end_time - start_time) / 1000000 ))
  wt_size=$(du -sm "$wt_path" 2>/dev/null | awk '{print $1}')

  printf "  %-14s %5d ms    %s MB\n" "$name" "$elapsed_ms" "${wt_size:-0}"

  WT_TIMES+=("$elapsed_ms")
  WT_SIZES+=("${wt_size:-0}")
done

wt_total_time=0
wt_total_size=0
for t in "${WT_TIMES[@]}"; do wt_total_time=$((wt_total_time + t)); done
for s in "${WT_SIZES[@]}"; do wt_total_size=$((wt_total_size + s)); done
echo "  ──────────────────────────────────"
printf "  Total:         %5d ms    %s MB\n" "$wt_total_time" "$wt_total_size"

# ── Synthetic workload script ────────────────────────────────────────
WORKLOAD_SCRIPT="$BENCH_TMPDIR/workload.sh"
cat > "$WORKLOAD_SCRIPT" <<'WORKEOF'
#!/bin/bash
# Synthetic workload simulating agent behavior inside the sandbox
DURATION=${1:-30}
END_TIME=$(($(date +%s) + DURATION))

cd /workspace || exit 1

iteration=0
while [ "$(date +%s)" -lt "$END_TIME" ]; do
  iteration=$((iteration + 1))

  # Git operations
  git status >/dev/null 2>&1
  git log --oneline -5 >/dev/null 2>&1
  git diff >/dev/null 2>&1

  # File I/O — simulate code edits
  if [ -f src/index.ts ]; then
    echo "// edit iteration $iteration — $(date +%H:%M:%S)" >> src/index.ts
    git add src/index.ts 2>/dev/null
    git commit -m "iteration $iteration" --quiet 2>/dev/null || true
  fi

  # CPU burst — simulate tool execution overhead
  dd if=/dev/urandom bs=4096 count=256 2>/dev/null | sha256sum >/dev/null 2>&1 &

  # Memory growth — simulate context accumulation (only if node available)
  if command -v node >/dev/null 2>&1; then
    node -e "
      const buf = Buffer.alloc(1024 * 1024 * Math.min($iteration, 50));
      let sum = 0;
      for (let i = 0; i < buf.length; i += 4096) sum += buf[i];
    " 2>/dev/null || true
  fi

  # Process creation — exercise PID limit
  for j in $(seq 1 5); do
    (echo "$j" | cat | wc -c) >/dev/null 2>&1
  done

  sleep 1
done

wait 2>/dev/null
echo "Workload completed after $iteration iterations"
WORKEOF
chmod +x "$WORKLOAD_SCRIPT"

# ── Launch containers ────────────────────────────────────────────────
echo ""
echo "--- Launching $NUM_CONTAINERS containers ---"

# Indexed arrays (0-based): C_PIDS[i], C_START[i]
C_PIDS=()
C_START=()

for i in $(seq 1 "$NUM_CONTAINERS"); do
  name=$(cname "$i")
  wt_path="$WORKSPACE-worktrees/$name"
  vol_name="benchmark-session-$name"
  idx=$((i - 1))

  podman volume exists "$vol_name" 2>/dev/null || podman volume create "$vol_name" >/dev/null

  C_START[$idx]=$(date +%s)

  # Launch with the same hardening flags as sandbox-run.sh (lines 142-175)
  podman run --rm \
    --name "$name" \
    --label "benchmark=true" \
    --user 1001:1001 \
    --network none \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --security-opt seccomp="$SECCOMP_PROFILE" \
    --security-opt mask=/proc/kcore \
    --security-opt mask=/proc/kallsyms \
    --security-opt mask=/proc/timer_list \
    --security-opt mask=/proc/sched_debug \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    --tmpfs /dev/shm:rw,nosuid,nodev,noexec,size=64m \
    --memory 4g \
    --pids-limit 512 \
    --cpus 2 \
    --ulimit core=0 \
    -e GIT_AUTHOR_NAME="Benchmark Agent" \
    -e GIT_AUTHOR_EMAIL="bench@sandbox" \
    -e GIT_COMMITTER_NAME="Benchmark Agent" \
    -e GIT_COMMITTER_EMAIL="bench@sandbox" \
    -v "$wt_path:/workspace:rw" \
    -v "$WORKLOAD_SCRIPT:/tmp/workload.sh:ro" \
    --mount "type=volume,src=${vol_name},dst=/home/agent" \
    "$IMAGE" \
    -c "bash /tmp/workload.sh $DURATION" \
    > "$BENCH_TMPDIR/$name.log" 2>&1 &

  C_PIDS[$idx]=$!
  LAUNCHED=$((LAUNCHED + 1))
  echo "  Started $name (PID ${C_PIDS[$idx]})"

  # Stagger launches by 0.5s to avoid VM startup contention (macOS)
  if [ "$i" -lt "$NUM_CONTAINERS" ]; then
    sleep 0.5
  fi
done

# ── Collect metrics (background) ─────────────────────────────────────
echo ""
echo "--- Collecting metrics (sampling every 2s) ---"

# Build space-separated list of container names for podman stats
BENCH_NAMES=""
for i in $(seq 1 "$NUM_CONTAINERS"); do
  BENCH_NAMES="$BENCH_NAMES $(cname "$i")"
done

(
  while true; do
    # Check if any benchmark containers are still running
    still_running=0
    for n in $BENCH_NAMES; do
      podman inspect --type container "$n" >/dev/null 2>&1 && still_running=1 && break
    done
    if [ "$still_running" -eq 0 ] && [ -s "$STATS_FILE" ]; then
      break
    fi
    podman stats --no-stream \
      --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}' \
      $BENCH_NAMES 2>/dev/null >> "$STATS_FILE" || true
    echo "---" >> "$STATS_FILE"
    sleep 2
  done
) &
STATS_PID=$!

# ── Wait for containers ──────────────────────────────────────────────
echo ""
echo "--- Waiting for containers to finish ---"

# Indexed arrays (0-based)
C_EXIT=()
C_DUR=()

for i in $(seq 1 "$NUM_CONTAINERS"); do
  idx=$((i - 1))
  name=$(cname "$i")
  wait "${C_PIDS[$idx]}" 2>/dev/null && C_EXIT[$idx]=0 || C_EXIT[$idx]=$?
  end_time=$(date +%s)
  C_DUR[$idx]=$(( end_time - ${C_START[$idx]} ))
  printf "  %-14s exited %d  (%ds)\n" "$name" "${C_EXIT[$idx]}" "${C_DUR[$idx]}"
done

# Stop stats collector
sleep 2
kill "$STATS_PID" 2>/dev/null || true
wait "$STATS_PID" 2>/dev/null || true

# ── Parse metrics ────────────────────────────────────────────────────
echo ""
echo "--- Processing metrics ---"

# Indexed arrays (0-based): per-container peak/sum values
PEAK_CPU=()
SUM_CPU=()
PEAK_MEM=()
SUM_MEM=()
PEAK_PIDS=()
SAMPLES=()

for i in $(seq 0 $((NUM_CONTAINERS - 1))); do
  PEAK_CPU[$i]=0; SUM_CPU[$i]=0
  PEAK_MEM[$i]=0; SUM_MEM[$i]=0
  PEAK_PIDS[$i]=0; SAMPLES[$i]=0
done

# Map container name → 0-based index
name_to_idx() {
  local n="$1"
  for i in $(seq 1 "$NUM_CONTAINERS"); do
    if [ "$(cname "$i")" = "$n" ]; then
      echo $((i - 1))
      return
    fi
  done
  echo "-1"
}

while IFS=$'\t' read -r sname scpu smem smemp spids; do
  [ -z "$sname" ] && continue
  [ "$sname" = "---" ] && continue

  idx=$(name_to_idx "$sname")
  [ "$idx" = "-1" ] && continue

  cpu_val=$(echo "$scpu" | tr -d '%' | awk '{printf "%.0f", $1}')
  mem_val=$(echo "$smem" | awk '{
    raw=$1; gsub(/[^0-9.]/, "", raw); val=raw+0
    u=$1 $2
    if (u ~ /[Gg][Ii]?[Bb]/) val=val*1024
    else if (u ~ /[Kk][Ii]?[Bb]/) val=val/1024
    printf "%.0f", val
  }')
  pid_val=$(echo "$spids" | tr -d ' ')

  SAMPLES[$idx]=$(( ${SAMPLES[$idx]} + 1 ))

  if [ "${cpu_val:-0}" -gt "${PEAK_CPU[$idx]}" ]; then PEAK_CPU[$idx]=$cpu_val; fi
  if [ "${mem_val:-0}" -gt "${PEAK_MEM[$idx]}" ]; then PEAK_MEM[$idx]=$mem_val; fi
  if [ "${pid_val:-0}" -gt "${PEAK_PIDS[$idx]}" ]; then PEAK_PIDS[$idx]=$pid_val; fi

  SUM_CPU[$idx]=$(( ${SUM_CPU[$idx]} + ${cpu_val:-0} ))
  SUM_MEM[$idx]=$(( ${SUM_MEM[$idx]} + ${mem_val:-0} ))
done < "$STATS_FILE"

# Compute averages
AVG_CPU=()
AVG_MEM=()
for i in $(seq 0 $((NUM_CONTAINERS - 1))); do
  count=${SAMPLES[$i]}
  if [ "$count" -gt 0 ]; then
    AVG_CPU[$i]=$(( ${SUM_CPU[$i]} / count ))
    AVG_MEM[$i]=$(( ${SUM_MEM[$i]} / count ))
  else
    AVG_CPU[$i]=0
    AVG_MEM[$i]=0
  fi
done

# ── Disk measurements ────────────────────────────────────────────────
VOL_SIZES=()
vol_total=0

for i in $(seq 1 "$NUM_CONTAINERS"); do
  idx=$((i - 1))
  vol_name="benchmark-session-$(cname "$i")"
  vol_mount=$(podman volume inspect "$vol_name" --format '{{.Mountpoint}}' 2>/dev/null || echo "")
  if [ -n "$vol_mount" ]; then
    VOL_SIZES[$idx]=$(du -sm "$vol_mount" 2>/dev/null | awk '{print $1}' || echo 0)
  else
    VOL_SIZES[$idx]=0
  fi
  vol_total=$((vol_total + ${VOL_SIZES[$idx]}))
done

# ── Final host memory ────────────────────────────────────────────────
FINAL_MEM_MB=$(get_host_mem_mb)
MEM_DELTA=$((FINAL_MEM_MB - BASELINE_MEM_MB))

# ── Print report ─────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo " SANDBOX RESOURCE BENCHMARK — RESULTS"
echo " Containers: $NUM_CONTAINERS  |  Duration: ${DURATION}s each"
echo "=========================================="

echo ""
echo "--- Worktree Creation ---"
for i in $(seq 0 $((NUM_CONTAINERS - 1))); do
  name=$(cname $((i + 1)))
  printf "  %-14s %5d ms    %s MB\n" "$name" "${WT_TIMES[$i]}" "${WT_SIZES[$i]}"
done
echo "  ──────────────────────────────────"
printf "  Total:         %5d ms    %s MB\n" "$wt_total_time" "$wt_total_size"

echo ""
echo "--- Container Resources (peak / avg) ---"
printf "  %-14s %-12s %-16s %-8s %-10s %s\n" "Name" "CPU%" "Memory" "PIDs" "Duration" "Exit"
for i in $(seq 0 $((NUM_CONTAINERS - 1))); do
  name=$(cname $((i + 1)))
  printf "  %-14s %d%%/%d%%      %dMB/%dMB       %-8s %-10s %s\n" \
    "$name" \
    "${PEAK_CPU[$i]}" "${AVG_CPU[$i]}" \
    "${PEAK_MEM[$i]}" "${AVG_MEM[$i]}" \
    "${PEAK_PIDS[$i]}" \
    "${C_DUR[$i]}s" \
    "${C_EXIT[$i]}"
done

total_peak_cpu=0
total_peak_mem=0
for i in $(seq 0 $((NUM_CONTAINERS - 1))); do
  total_peak_cpu=$((total_peak_cpu + ${PEAK_CPU[$i]}))
  total_peak_mem=$((total_peak_mem + ${PEAK_MEM[$i]}))
done

echo ""
echo "--- Aggregate ---"
printf "  Total CPU (peak sum):      %d%%\n" "$total_peak_cpu"
printf "  Total memory (peak sum):   %d MB\n" "$total_peak_mem"
printf "  Podman volume storage:     %d MB\n" "$vol_total"
printf "  Worktree disk total:       %d MB\n" "$wt_total_size"
printf "  Total disk footprint:      %d MB\n" "$((vol_total + wt_total_size))"

echo ""
echo "--- Host Impact ---"
printf "  Baseline memory:           %d MB\n" "$BASELINE_MEM_MB"
printf "  Post-benchmark memory:     %d MB\n" "$FINAL_MEM_MB"
printf "  Delta:                     %d MB\n" "$MEM_DELTA"

if [ "$(uname)" = "Darwin" ]; then
  echo ""
  echo "  NOTE: CPU% from podman stats reflects Podman VM usage, not direct host CPU."
  echo "  Memory delta is measured on the host, but container memory is within the VM."
fi

echo ""
echo "=========================================="

# ── JSON output ──────────────────────────────────────────────────────
if [ -n "$OUTPUT_FILE" ]; then
  {
    echo '{'
    echo '  "benchmark": {'
    echo "    \"containers\": $NUM_CONTAINERS,"
    echo "    \"duration_seconds\": $DURATION,"
    echo "    \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "    \"platform\": \"$(uname -s)\","
    echo "    \"podman_version\": \"$(podman version --format '{{.Client.Version}}' 2>/dev/null)\""
    echo '  },'

    echo '  "worktrees": ['
    for i in $(seq 0 $((NUM_CONTAINERS - 1))); do
      name=$(cname $((i + 1)))
      comma=","; [ "$i" -eq $((NUM_CONTAINERS - 1)) ] && comma=""
      echo "    {\"name\": \"$name\", \"creation_ms\": ${WT_TIMES[$i]}, \"size_mb\": ${WT_SIZES[$i]}}$comma"
    done
    echo '  ],'

    echo '  "containers": ['
    for i in $(seq 0 $((NUM_CONTAINERS - 1))); do
      name=$(cname $((i + 1)))
      comma=","; [ "$i" -eq $((NUM_CONTAINERS - 1)) ] && comma=""
      cat <<CEOF
    {
      "name": "$name",
      "peak_cpu_pct": ${PEAK_CPU[$i]},
      "avg_cpu_pct": ${AVG_CPU[$i]},
      "peak_mem_mb": ${PEAK_MEM[$i]},
      "avg_mem_mb": ${AVG_MEM[$i]},
      "peak_pids": ${PEAK_PIDS[$i]},
      "samples": ${SAMPLES[$i]},
      "duration_seconds": ${C_DUR[$i]},
      "exit_code": ${C_EXIT[$i]},
      "volume_size_mb": ${VOL_SIZES[$i]}
    }$comma
CEOF
    done
    echo '  ],'

    echo '  "aggregate": {'
    printf "    \"total_peak_cpu_pct\": %d,\n" "$total_peak_cpu"
    printf "    \"total_peak_mem_mb\": %d,\n" "$total_peak_mem"
    printf "    \"volume_storage_mb\": %d,\n" "$vol_total"
    printf "    \"worktree_disk_mb\": %d,\n" "$wt_total_size"
    printf "    \"total_disk_mb\": %d\n" "$((vol_total + wt_total_size))"
    echo '  },'

    echo '  "host": {'
    printf "    \"total_mem_mb\": %d,\n" "$TOTAL_MEM_MB"
    printf "    \"baseline_mem_mb\": %d,\n" "$BASELINE_MEM_MB"
    printf "    \"final_mem_mb\": %d,\n" "$FINAL_MEM_MB"
    printf "    \"delta_mem_mb\": %d\n" "$MEM_DELTA"
    echo '  }'

    echo '}'
  } > "$OUTPUT_FILE"
  echo "JSON report written to: $OUTPUT_FILE"
fi

echo "Done."
