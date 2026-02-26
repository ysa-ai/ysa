#!/bin/bash
# preflight-check.sh — Verify host security prerequisites before running sandboxes
# Run this periodically or before deploying to catch misconfigurations

set -uo pipefail

PASS=0
FAIL=0
WARN=0

ok()   { PASS=$((PASS+1)); echo "  [OK]   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  [FAIL] $1"; }
warn() { WARN=$((WARN+1)); echo "  [WARN] $1"; }

echo "=========================================="
echo " SANDBOX PREFLIGHT CHECK"
echo "=========================================="

# ── 1. Podman ─────────────────────────────────────────────────────────
echo ""
echo "--- Podman ---"
if command -v podman >/dev/null 2>&1; then
  podman_ver=$(podman version --format '{{.Client.Version}}' 2>/dev/null)
  ok "Podman installed: v$podman_ver"

  major=$(echo "$podman_ver" | cut -d. -f1)
  minor=$(echo "$podman_ver" | cut -d. -f2)
  if [ "$major" -ge 5 ]; then
    ok "Podman version >= 5.0 (supports latest security features)"
  else
    warn "Podman version $podman_ver is old — upgrade to 5.x+ recommended"
  fi
else
  fail "Podman not installed"
fi

# ── 2. Container Runtime ──────────────────────────────────────────────
echo ""
echo "--- Container Runtime ---"
runtime_name=$(podman info --format '{{.Host.OCIRuntime.Name}}' 2>/dev/null)
runtime_ver_full=$(podman info --format '{{.Host.OCIRuntime.Version}}' 2>/dev/null | head -1)

if [ "$runtime_name" = "crun" ]; then
  ok "Runtime is crun (preferred over runc)"
  crun_ver=$(echo "$runtime_ver_full" | grep -oE '[0-9]+\.[0-9]+' | head -1)
  crun_major=$(echo "$crun_ver" | cut -d. -f1)
  crun_minor=$(echo "$crun_ver" | cut -d. -f2)
  if [ "$crun_major" -ge 1 ] && [ "$crun_minor" -ge 19 ]; then
    ok "crun version $crun_ver (post CVE-2025 patches)"
  else
    warn "crun version $crun_ver may be affected by CVE-2025-31133/52565/52881"
  fi
elif [ "$runtime_name" = "runc" ]; then
  warn "Runtime is runc — crun is recommended for better security"
  runc_ver=$(echo "$runtime_ver_full" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  # runc >= 1.2.8 needed for CVE-2025 fixes
  runc_patch=$(echo "$runc_ver" | cut -d. -f3)
  if [ "${runc_patch:-0}" -ge 8 ]; then
    ok "runc version $runc_ver (patched)"
  else
    fail "runc version $runc_ver is vulnerable to CVE-2025-31133/52565/52881 — upgrade to >= 1.2.8"
  fi
else
  warn "Unknown runtime: $runtime_name"
fi

# ── 3. Rootless mode ──────────────────────────────────────────────────
echo ""
echo "--- Rootless Mode ---"
if [ "$(id -u)" != "0" ]; then
  ok "Running as non-root user (rootless Podman)"
else
  fail "Running as root — rootless Podman required for security"
fi

rootless=$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)
if [ "$rootless" = "true" ]; then
  ok "Podman is in rootless mode"
else
  fail "Podman is NOT in rootless mode"
fi

# ── 4. Image ──────────────────────────────────────────────────────────
echo ""
echo "--- Container Image ---"
if podman image exists sandbox-claude 2>/dev/null; then
  ok "sandbox-claude image exists"
  created=$(podman image inspect sandbox-claude --format '{{.Created}}' 2>/dev/null)
  echo "       Created: $created"
else
  fail "sandbox-claude image not built — run: podman build -t sandbox-claude -f Containerfile ."
fi

# ── 5. Seccomp profile ────────────────────────────────────────────────
echo ""
echo "--- Seccomp Profile ---"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../seccomp.json" ]; then
  ok "seccomp.json found"
  syscall_count=$(grep -c '"SCMP_ACT_ALLOW"' "$SCRIPT_DIR/../seccomp.json")
  echo "       Allowed syscall groups: $syscall_count"
else
  fail "seccomp.json not found in $SCRIPT_DIR/.."
fi

# ── 6. Kernel features ───────────────────────────────────────────────
echo ""
echo "--- Kernel ---"
kernel_ver=$(uname -r)
ok "Kernel: $kernel_ver"

# Check user namespaces support
if [ -f /proc/sys/user/max_user_namespaces ]; then
  max_userns=$(cat /proc/sys/user/max_user_namespaces)
  if [ "$max_userns" -gt 0 ]; then
    ok "User namespaces enabled (max: $max_userns)"
  else
    fail "User namespaces disabled (max_user_namespaces = 0)"
  fi
else
  ok "User namespaces (macOS/VM — managed by Podman machine)"
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo " RESULTS: $PASS ok, $WARN warnings, $FAIL failures"
echo "=========================================="

if [ $FAIL -gt 0 ]; then
  echo " FIX FAILURES BEFORE RUNNING SANDBOXES"
  exit 1
elif [ $WARN -gt 0 ]; then
  echo " Warnings found — review above"
  exit 0
else
  echo " All checks passed!"
  exit 0
fi
