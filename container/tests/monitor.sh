#!/bin/bash
# monitor.sh — Live resource monitor for running sandbox containers
#
# Usage: bash packages/core/container/monitor.sh [--interval N] [--output FILE] [--once]
#
# Discovers running sandbox containers (name prefix "sandbox-" or "bench-"),
# polls CPU/memory/PIDs, writes structured metrics to a file, and warns
# when host resources are running low.

set -uo pipefail

# ── Defaults ─────────────────────────────────────────────────────────
INTERVAL=5
OUTPUT_FILE=""
ONCE=false
WARN_MEM_PCT=85   # warn when host memory exceeds this %
WARN_DISK_GB=5    # warn when free disk drops below this

# ── Parse args ───────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --interval)  INTERVAL="$2"; shift 2 ;;
    --output)    OUTPUT_FILE="$2"; shift 2 ;;
    --once)      ONCE=true; shift ;;
    --warn-mem)  WARN_MEM_PCT="$2"; shift 2 ;;
    --warn-disk) WARN_DISK_GB="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--interval N] [--output FILE] [--once]"
      echo ""
      echo "  --interval   Polling interval in seconds (default: 5)"
      echo "  --output     Append JSON metrics to FILE"
      echo "  --once       Single snapshot, then exit"
      echo "  --warn-mem   Warn when host memory usage exceeds N% (default: 85)"
      echo "  --warn-disk  Warn when free disk drops below N GB (default: 5)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Host info ────────────────────────────────────────────────────────
get_host_mem() {
  # Returns: used_mb total_mb
  if [ "$(uname)" = "Darwin" ]; then
    local ps ap wp cp up total
    ps=$(vm_stat | head -1 | grep -oE '[0-9]+')
    ap=$(vm_stat | awk '/Pages active:/ {gsub(/\./,"",$(NF)); print $(NF)}')
    wp=$(vm_stat | awk '/Pages wired down:/ {gsub(/\./,"",$(NF)); print $(NF)}')
    cp=$(vm_stat | awk '/Pages occupied by compressor:/ {gsub(/\./,"",$(NF)); print $(NF)}')
    up=$(( ${ap:-0} + ${wp:-0} + ${cp:-0} ))
    local used=$(( up * ${ps:-16384} / 1024 / 1024 ))
    total=$(( $(sysctl -n hw.memsize 2>/dev/null) / 1024 / 1024 ))
    echo "$used $total"
  else
    free -m 2>/dev/null | awk '/^Mem:/ {print $3, $2}' || echo "0 0"
  fi
}

get_free_disk_gb() {
  if [ "$(uname)" = "Darwin" ]; then
    df -g "$HOME" 2>/dev/null | awk 'NR==2 {print $4}'
  else
    df -BG "$HOME" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}'
  fi
}

# ── Container discovery ──────────────────────────────────────────────
discover_containers() {
  # Find running containers with sandbox- or bench- prefix
  podman ps --format '{{.Names}}' 2>/dev/null | grep -E '^(sandbox-|bench-)' || true
}

# ── Single snapshot ──────────────────────────────────────────────────
snapshot() {
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local containers
  containers=$(discover_containers)

  if [ -z "$containers" ]; then
    echo "[$ts] No sandbox containers running"
    return 1
  fi

  local count
  count=$(echo "$containers" | wc -l | tr -d ' ')

  # Get per-container stats
  local stats_raw
  stats_raw=$(podman stats --no-stream \
    --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}' \
    $containers 2>/dev/null) || true

  if [ -z "$stats_raw" ]; then
    echo "[$ts] $count containers found but stats unavailable"
    return 1
  fi

  # Host state
  local host_mem free_disk
  host_mem=$(get_host_mem)
  local host_used_mb host_total_mb
  host_used_mb=$(echo "$host_mem" | awk '{print $1}')
  host_total_mb=$(echo "$host_mem" | awk '{print $2}')
  local host_pct=0
  if [ "$host_total_mb" -gt 0 ]; then
    host_pct=$(( host_used_mb * 100 / host_total_mb ))
  fi
  free_disk=$(get_free_disk_gb)

  # Parse container stats and compute aggregates
  local total_cpu=0 total_mem_mb=0 total_pids=0
  local container_json=""
  local sep=""

  while IFS=$'\t' read -r cname ccpu cmem cmemp cpids; do
    [ -z "$cname" ] && continue

    local cpu_val mem_val pid_val
    cpu_val=$(echo "$ccpu" | tr -d '%' | awk '{printf "%.1f", $1}')
    mem_val=$(echo "$cmem" | awk '{
      raw=$1; gsub(/[^0-9.]/, "", raw); val=raw+0
      u=$1 $2
      if (u ~ /[Gg][Ii]?[Bb]/) val=val*1024
      else if (u ~ /[Kk][Ii]?[Bb]/) val=val/1024
      printf "%.0f", val
    }')
    pid_val=$(echo "$cpids" | tr -d ' ')

    total_cpu=$(echo "$total_cpu + $cpu_val" | bc 2>/dev/null || echo "$total_cpu")
    total_mem_mb=$((total_mem_mb + ${mem_val:-0}))
    total_pids=$((total_pids + ${pid_val:-0}))

    container_json="${container_json}${sep}{\"name\":\"$cname\",\"cpu_pct\":$cpu_val,\"mem_mb\":${mem_val:-0},\"pids\":${pid_val:-0}}"
    sep=","
  done <<< "$stats_raw"

  local host_free_mb=$((host_total_mb - host_used_mb))

  # ── Print to stdout ──────────────────────────────────────────────
  printf "\033[2J\033[H"  # clear screen
  echo "=========================================="
  echo " SANDBOX MONITOR  |  $ts"
  echo "=========================================="
  echo ""
  printf "  Containers: %-4s  Total PIDs: %s\n" "$count" "$total_pids"
  echo ""
  printf "  %-20s %-10s %-14s %s\n" "Name" "CPU%" "Memory (MB)" "PIDs"
  echo "$stats_raw" | while IFS=$'\t' read -r cname ccpu cmem cmemp cpids; do
    [ -z "$cname" ] && continue
    local mem_mb
    mem_mb=$(echo "$cmem" | awk '{
      raw=$1; gsub(/[^0-9.]/, "", raw); val=raw+0
      u=$1 $2
      if (u ~ /[Gg][Ii]?[Bb]/) val=val*1024
      else if (u ~ /[Kk][Ii]?[Bb]/) val=val/1024
      printf "%.0f", val
    }')
    printf "  %-20s %-10s %-14s %s\n" "$cname" "$ccpu" "${mem_mb} MB" "$cpids"
  done
  echo ""
  echo "  --- Aggregate ---"
  printf "  Container CPU total:  %.1f%%\n" "$total_cpu"
  printf "  Container memory:     %d MB\n" "$total_mem_mb"
  echo ""
  echo "  --- Host ---"
  printf "  Memory: %d / %d MB (%d%% used, %d MB free)\n" \
    "$host_used_mb" "$host_total_mb" "$host_pct" "$host_free_mb"
  printf "  Disk free: %s GB\n" "${free_disk:-?}"

  # ── Warnings ───────────────────────────────────────────────────────
  local warnings=""
  if [ "$host_pct" -ge "$WARN_MEM_PCT" ]; then
    warnings="${warnings}\n  [WARN] Host memory at ${host_pct}% — OOM risk if launching more containers"
  fi
  if [ -n "$free_disk" ] && [ "$free_disk" -lt "$WARN_DISK_GB" ] 2>/dev/null; then
    warnings="${warnings}\n  [WARN] Disk free ${free_disk} GB — below ${WARN_DISK_GB} GB threshold"
  fi

  # Estimate remaining capacity (based on 1.5 GB per container avg from benchmarks)
  local per_container_mb=1500
  local remaining=$((host_free_mb / per_container_mb))
  if [ "$remaining" -lt 2 ]; then
    warnings="${warnings}\n  [WARN] Estimated capacity for ~${remaining} more containers"
  fi

  if [ -n "$warnings" ]; then
    echo ""
    echo "  --- Warnings ---"
    printf "$warnings\n"
  fi

  # Capacity estimate
  echo ""
  printf "  Estimated headroom:   ~%d more containers (at ~1.5 GB each)\n" "$remaining"
  echo "=========================================="

  # ── Write to file ────────────────────────────────────────────────
  if [ -n "$OUTPUT_FILE" ]; then
    local json
    json="{\"timestamp\":\"$ts\",\"containers\":[$container_json],\"aggregate\":{\"count\":$count,\"total_cpu_pct\":$total_cpu,\"total_mem_mb\":$total_mem_mb,\"total_pids\":$total_pids},\"host\":{\"mem_used_mb\":$host_used_mb,\"mem_total_mb\":$host_total_mb,\"mem_pct\":$host_pct,\"mem_free_mb\":$host_free_mb,\"disk_free_gb\":${free_disk:-0}}"

    # Add warnings array
    local warn_json="[]"
    if [ "$host_pct" -ge "$WARN_MEM_PCT" ]; then
      warn_json="[\"memory_high\"]"
    fi
    if [ -n "$free_disk" ] && [ "$free_disk" -lt "$WARN_DISK_GB" ] 2>/dev/null; then
      if [ "$warn_json" = "[]" ]; then
        warn_json="[\"disk_low\"]"
      else
        warn_json=$(echo "$warn_json" | sed 's/]$/,"disk_low"]/')
      fi
    fi

    json="${json},\"warnings\":$warn_json}"
    echo "$json" >> "$OUTPUT_FILE"
  fi

  return 0
}

# ── Main loop ────────────────────────────────────────────────────────
if [ "$ONCE" = true ]; then
  snapshot
  exit $?
fi

echo "Monitoring sandbox containers every ${INTERVAL}s (Ctrl+C to stop)..."
if [ -n "$OUTPUT_FILE" ]; then
  echo "Writing metrics to: $OUTPUT_FILE"
fi
echo ""

while true; do
  snapshot || true
  sleep "$INTERVAL"
done
