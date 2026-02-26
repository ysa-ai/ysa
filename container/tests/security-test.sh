#!/bin/bash
# security-test.sh — Run the full ysa security test suite
#
# Runs both the container sandbox attack tests and the network proxy tests.
# This is the authoritative proof that the sandbox is hardened correctly.
#
# Usage: bash container/security-test.sh [--skip-network]
#
# Requirements:
#   - Podman installed and in rootless mode
#   - sandbox image built (sandbox-claude or sandbox-mistral)
#   - For network tests: ysa server running (proxy auto-starts on first restricted task)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKIP_NETWORK=false
PROXY_WAS_RUNNING=false
PROXY_STARTED=false

for arg in "$@"; do
  if [ "$arg" = "--skip-network" ]; then
    SKIP_NETWORK=true
  fi
done

start_proxy() {
  # Always restart to ensure the running image matches the current build
  podman stop ysa-proxy 2>/dev/null || true
  podman rm -f ysa-proxy 2>/dev/null || true
  podman run -d \
    --name ysa-proxy \
    --user 0:0 \
    --network slirp4netns \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --security-opt seccomp="$CONTAINER_DIR/seccomp.json" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --memory 512m \
    --pids-limit 128 \
    --cpus 1 \
    -p 3128:3128 \
    -e PROXY_BYPASS_HOSTS=api.anthropic.com,statsig.anthropic.com \
    sandbox-proxy >/dev/null
  PROXY_STARTED=true
  sleep 1  # give proxy a moment to be ready
}

stop_proxy() {
  if [ "$PROXY_STARTED" = true ]; then
    podman stop ysa-proxy >/dev/null 2>&1 || true
    podman rm -f ysa-proxy >/dev/null 2>&1 || true
  fi
}

PASS_TOTAL=0
FAIL_TOTAL=0

separator() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

# ── 1. Container sandbox attack tests ────────────────────────────────────
separator "CONTAINER SANDBOX — attack-test.sh (155 tests, 38 categories)"

if bash "$SCRIPT_DIR/run-attack-test.sh"; then
  PASS_TOTAL=$((PASS_TOTAL + 1))
  echo ""
  echo "✓ Container sandbox: PASSED"
else
  FAIL_TOTAL=$((FAIL_TOTAL + 1))
  echo ""
  echo "✗ Container sandbox: FAILED"
fi

# ── 2. Network proxy tests ────────────────────────────────────────────────
if [ "$SKIP_NETWORK" = true ]; then
  separator "NETWORK PROXY — skipped (--skip-network)"
else
  separator "NETWORK PROXY — network-proxy-test.sh (60 tests, L7 + L3/L4)"

  if ! start_proxy; then
    FAIL_TOTAL=$((FAIL_TOTAL + 1))
    echo "✗ Network proxy: FAILED (could not start proxy container — is sandbox-proxy image built?)"
  else
    if bash "$SCRIPT_DIR/network-proxy-test.sh"; then
      PASS_TOTAL=$((PASS_TOTAL + 1))
      echo ""
      echo "✓ Network proxy: PASSED"
    else
      FAIL_TOTAL=$((FAIL_TOTAL + 1))
      echo ""
      echo "✗ Network proxy: FAILED"
    fi
    stop_proxy
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────
separator "SUMMARY"

if [ "$SKIP_NETWORK" = true ]; then
  echo "  Suites run: 1 (network skipped)"
else
  echo "  Suites run: 2"
fi

echo "  Passed:     $PASS_TOTAL"
echo "  Failed:     $FAIL_TOTAL"
echo ""

if [ "$FAIL_TOTAL" -eq 0 ]; then
  echo "  All security tests passed."
  exit 0
else
  echo "  $FAIL_TOTAL suite(s) failed."
  exit 1
fi
