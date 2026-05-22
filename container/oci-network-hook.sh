#!/bin/bash
# oci-network-hook.sh — OCI createContainer hook for network policy enforcement.
#
# Applies iptables rules inside the sandbox container's network namespace
# BEFORE the container process starts. Forces all outbound traffic through
# the proxy and blocks direct internet access.
#
# Invoked by Podman via OCI hooks when annotation network_policy=strict|custom.
# Reads container state JSON from stdin (OCI hook spec).

set -euo pipefail

# On Linux rootless podman, hooks run as the regular user (not root).
# iptables/nsenter require elevated privileges — granted via sudoers by setup-network-hooks.sh.
# On macOS, hooks run as root inside the Podman Machine VM so sudo is a no-op.
SUDO=""
if [ "$(id -u)" != "0" ]; then
  SUDO="sudo"
fi

# Read OCI state from stdin
STATE=$(cat)

# Extract the container PID (needed to enter its network namespace)
PID=$(echo "$STATE" | jq -r '.pid // empty')
if [ -z "$PID" ]; then
  echo "[oci-hook] ERROR: No PID in container state" >&2
  exit 1
fi

# Resolve the host IP that containers use for host.containers.internal.
# podman resolves --add-host host.containers.internal:host-gateway to the host's
# primary outbound IP. We derive the same via ip route get.
HOST_IP=""

# Primary: host's outbound source IP — matches podman host-gateway resolution
HOST_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++){if($i=="src"){print $(i+1);exit}}}') || true

# Fallback: try resolving from the host
if [ -z "$HOST_IP" ]; then
  HOST_IP=$(getent hosts host.containers.internal 2>/dev/null | awk '{print $1}' | head -1) || true
fi

if [ -z "$HOST_IP" ]; then
  echo "[oci-hook] WARNING: Could not determine host IP, using 10.0.2.2 (slirp4netns default)" >&2
  HOST_IP="10.0.2.2"
fi

PROXY_PORT=3128

# Server port: read from OCI bundle config.json process.env (set by orchestrator).
# /proc/$PID/environ is not the container env at createRuntime stage.
BUNDLE=$(echo "$STATE" | jq -r '.bundle // empty')
CONTAINER_SERVER_PORT=""
if [ -n "$BUNDLE" ] && [ -f "$BUNDLE/config.json" ]; then
  CONTAINER_SERVER_PORT=$(jq -r '.process.env[] | select(startswith("SERVER_PORT=")) | ltrimstr("SERVER_PORT=")' "$BUNDLE/config.json" 2>/dev/null | head -1) || true
fi
SERVER_PORT="${CONTAINER_SERVER_PORT:-${SERVER_PORT:-4000}}"

# Derive host.containers.internal IP from the VM's own subnet.
# On macOS Podman Machine, HOST_IP is on 192.168.127.x/24 and
# host-gateway resolves to 192.168.127.254 inside slirp4netns containers.
# We compute the .254 address from the same /24 as HOST_IP.
# On Linux where HOST_IP is in a different range, HCI_IP stays empty (no extra rule needed).
HCI_IP=""
if echo "$HOST_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  NET_PREFIX="${HOST_IP%.*}"
  CANDIDATE="${NET_PREFIX}.254"
  if [ "$CANDIDATE" != "$HOST_IP" ]; then
    HCI_IP="$CANDIDATE"
  fi
fi

echo "[oci-hook] Applying network policy rules for PID $PID (host: $HOST_IP, hci: ${HCI_IP:-n/a}, server_port: $SERVER_PORT)" >&2

# ── IPv4 rules ───────────────────────────────────────────────────────────────

# Enter the container's network namespace and apply rules
$SUDO nsenter -t "$PID" -n iptables -P OUTPUT DROP

# Allow loopback
$SUDO nsenter -t "$PID" -n iptables -A OUTPUT -o lo -j ACCEPT

# Allow established/related connections (return traffic)
$SUDO nsenter -t "$PID" -n iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Allow TCP to proxy (host.containers.internal:3128)
$SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p tcp -d "$HOST_IP" --dport "$PROXY_PORT" -j ACCEPT

# Allow TCP to server for prompt/API (host.containers.internal:SERVER_PORT)
$SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p tcp -d "$HOST_IP" --dport "$SERVER_PORT" -j ACCEPT

# Allow traffic to host.containers.internal (.254 in macOS Podman Machine) if it differs from HOST_IP.
if [ -n "$HCI_IP" ] && [ "$HCI_IP" != "$HOST_IP" ]; then
  $SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p tcp -d "$HCI_IP" --dport "$PROXY_PORT" -j ACCEPT
  $SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p tcp -d "$HCI_IP" --dport "$SERVER_PORT" -j ACCEPT
fi

# Allow the slirp4netns gateway too — it may differ from HOST_IP and is used for proxy/server access.
GATEWAY_IP=$($SUDO nsenter -t "$PID" -n ip route 2>/dev/null | awk '/default/{print $3; exit}') || true
if [ -n "$GATEWAY_IP" ] && [ "$GATEWAY_IP" != "$HOST_IP" ]; then
  $SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p tcp -d "$GATEWAY_IP" --dport "$PROXY_PORT" -j ACCEPT
  $SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p tcp -d "$GATEWAY_IP" --dport "$SERVER_PORT" -j ACCEPT
fi

# Allow DNS to the slirp4netns DNS server (always gateway+1) and to HOST_IP/HCI_IP
# (macOS Podman Machine also uses HOST_IP as a nameserver).
# TCP:53 is needed for large DNS responses (e.g. MongoDB SRV records).
if [ -n "$GATEWAY_IP" ]; then
  GATEWAY_DNS="${GATEWAY_IP%.*}.$((${GATEWAY_IP##*.} + 1))"
  $SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p udp -d "$GATEWAY_DNS" --dport 53 -j ACCEPT
  $SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p tcp -d "$GATEWAY_DNS" --dport 53 -j ACCEPT
fi
for dns_host in "$HOST_IP" "${HCI_IP:-}"; do
  [ -z "$dns_host" ] && continue
  $SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p udp -d "$dns_host" --dport 53 -j ACCEPT
  $SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p tcp -d "$dns_host" --dport 53 -j ACCEPT
done

# Per-project bypass hosts — direct TCP access, skips proxy (for raw TCP protocols like MongoDB)
BYPASS_HOSTS_VAL=""
if [ -n "$BUNDLE" ] && [ -f "$BUNDLE/config.json" ]; then
  BYPASS_HOSTS_VAL=$(jq -r '.process.env[] | select(startswith("BYPASS_HOSTS=")) | ltrimstr("BYPASS_HOSTS=")' "$BUNDLE/config.json" 2>/dev/null | head -1) || true
fi

if [ -n "$BYPASS_HOSTS_VAL" ]; then
  OLD_IFS="$IFS"
  IFS=','
  for entry in $BYPASS_HOSTS_VAL; do
    IFS="$OLD_IFS"
    entry=$(echo "$entry" | tr -d ' ')
    [ -z "$entry" ] && continue
    host="${entry%%:*}"
    port=""
    if [ "$entry" != "$host" ]; then
      port="${entry##*:}"
    fi

    RESOLVED_IPS=""

    if command -v dig >/dev/null 2>&1; then
      # Direct A record
      A_IPS=$(dig +short A "$host" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$') || true
      RESOLVED_IPS="$A_IPS"

      # SRV chain (covers MongoDB and similar cloud DBs where the hostname has no direct A record)
      SRV_OUT=$(dig +short SRV "_mongodb._tcp.$host" 2>/dev/null) || true
      if [ -n "$SRV_OUT" ]; then
        while read -r _pri _wt _sp srv_target; do
          [ -z "$srv_target" ] && continue
          srv_target="${srv_target%.}"
          NODE_IPS=$(dig +short A "$srv_target" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$') || true
          RESOLVED_IPS="$RESOLVED_IPS $NODE_IPS"
        done <<EOF
$SRV_OUT
EOF
      fi
    else
      RESOLVED_IPS=$(getent hosts "$host" 2>/dev/null | awk '{print $1}') || true
    fi

    for ip in $RESOLVED_IPS; do
      [ -z "$ip" ] && continue
      if [ -n "$port" ]; then
        $SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p tcp -d "$ip" --dport "$port" -j ACCEPT
      else
        $SUDO nsenter -t "$PID" -n iptables -A OUTPUT -p tcp -d "$ip" -j ACCEPT
      fi
      echo "[oci-hook] Bypass ACCEPT: $host ($ip)${port:+:$port}" >&2
    done

    IFS=','
  done
  IFS="$OLD_IFS"
fi

# Drop everything else (already default, but explicit for clarity)
$SUDO nsenter -t "$PID" -n iptables -A OUTPUT -j DROP

# ── IPv6 rules ───────────────────────────────────────────────────────────────

# Disable IPv6 entirely
$SUDO nsenter -t "$PID" -n ip6tables -P INPUT DROP 2>/dev/null || true
$SUDO nsenter -t "$PID" -n ip6tables -P OUTPUT DROP 2>/dev/null || true
$SUDO nsenter -t "$PID" -n ip6tables -P FORWARD DROP 2>/dev/null || true

echo "[oci-hook] Network policy rules applied successfully" >&2
