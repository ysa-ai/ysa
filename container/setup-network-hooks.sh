#!/bin/bash
# setup-network-hooks.sh — Install OCI network hooks into the Podman VM (macOS) or host (Linux).
#
# One-time setup (re-run after podman machine reset/recreate on macOS).
# Installs the iptables enforcement hook that makes the proxy mandatory
# for containers with annotation network_policy=strict|custom.
#
# Usage: ./setup-network-hooks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM="$(uname -s)"

if [ "$PLATFORM" = "Linux" ]; then
  echo "Installing OCI network hooks (Linux native)..."

  # 1. Create directories
  mkdir -p "$HOME/.config/containers/oci/hooks.d" \
           "$HOME/.config/containers/containers.conf.d" \
           "$HOME/.local/share/ysa"

  # 2. Configure hooks_dir
  cat > "$HOME/.config/containers/containers.conf.d/hooks.conf" <<EOF
[engine]
hooks_dir = ["$HOME/.config/containers/oci/hooks.d"]
EOF

  # 3. Copy hook script
  cp "$SCRIPT_DIR/oci-network-hook.sh" "$HOME/.local/share/ysa/oci-network-hook.sh"
  chmod +x "$HOME/.local/share/ysa/oci-network-hook.sh"

  # 4. Copy hook config, rewriting the hook script path to the local install location
  sed "s|/opt/proxy/oci-network-hook.sh|$HOME/.local/share/ysa/oci-network-hook.sh|g" \
    "$SCRIPT_DIR/oci-hooks.d/network-policy.json" > "$HOME/.config/containers/oci/hooks.d/network-policy.json"

  # 5. Grant passwordless sudo for iptables/nsenter (required for rootless podman)
  #    The OCI hook runs as the current user (not root) and needs these to enforce
  #    L3/L4 network policy inside the container's network namespace.
  # Use the actual login user (SUDO_USER when invoked via sudo, else whoami)
  ACTUAL_USER="${SUDO_USER:-$(whoami)}"
  SUDOERS_FILE="/etc/sudoers.d/ysa-iptables-$ACTUAL_USER"
  SUDOERS_RULE="$ACTUAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/iptables, /usr/sbin/ip6tables, /usr/bin/nsenter"
  if echo "$SUDOERS_RULE" | sudo tee "$SUDOERS_FILE" > /dev/null 2>&1; then
    sudo chmod 440 "$SUDOERS_FILE"
    echo "  Sudoers rule installed: $SUDOERS_FILE"
  else
    echo "  WARNING: Could not install sudoers rule (no sudo access)."
    echo "  Restricted network policy requires L3/L4 enforcement. Add manually:"
    echo "    $SUDOERS_RULE"
  fi

  # 6. Verify
  echo ""
  echo "Verifying installation..."
  echo -n "  Hook script: "; test -x "$HOME/.local/share/ysa/oci-network-hook.sh" && echo "OK" || echo "MISSING"
  echo -n "  Hook config: "; test -f "$HOME/.config/containers/oci/hooks.d/network-policy.json" && echo "OK" || echo "MISSING"
  echo -n "  hooks_dir:   "; test -f "$HOME/.config/containers/containers.conf.d/hooks.conf" && echo "OK" || echo "MISSING"
  echo -n "  iptables:    "; which iptables > /dev/null 2>&1 && echo "OK" || echo "MISSING"
  echo -n "  jq:          "; which jq > /dev/null 2>&1 && echo "OK" || echo "MISSING"
  echo -n "  nsenter:     "; which nsenter > /dev/null 2>&1 && echo "OK" || echo "MISSING"
  echo -n "  sudoers:     "; test -f "$SUDOERS_FILE" && echo "OK" || echo "MISSING"

else
  echo "Installing OCI network hooks into Podman VM..."

  # 1. Create directories
  podman machine ssh -- 'sudo mkdir -p /etc/containers/oci/hooks.d /etc/containers/containers.conf.d /opt/proxy'

  # 2. Configure hooks_dir (default is /usr/share which is read-only on Fedora CoreOS)
  podman machine ssh -- 'echo "[engine]
hooks_dir = [\"/etc/containers/oci/hooks.d\"]" | sudo tee /etc/containers/containers.conf.d/hooks.conf > /dev/null'

  # 3. Copy hook script
  cat "$SCRIPT_DIR/oci-network-hook.sh" | podman machine ssh -- 'sudo tee /opt/proxy/oci-network-hook.sh > /dev/null && sudo chmod +x /opt/proxy/oci-network-hook.sh'

  # 4. Copy hook config
  cat "$SCRIPT_DIR/oci-hooks.d/network-policy.json" | podman machine ssh -- 'sudo tee /etc/containers/oci/hooks.d/network-policy.json > /dev/null'

  # 5. Verify
  echo ""
  echo "Verifying installation..."
  podman machine ssh -- '
    echo -n "  Hook script: "; test -x /opt/proxy/oci-network-hook.sh && echo "OK" || echo "MISSING"
    echo -n "  Hook config: "; test -f /etc/containers/oci/hooks.d/network-policy.json && echo "OK" || echo "MISSING"
    echo -n "  hooks_dir:   "; test -f /etc/containers/containers.conf.d/hooks.conf && echo "OK" || echo "MISSING"
    echo -n "  iptables:    "; which iptables > /dev/null 2>&1 && echo "OK" || echo "MISSING"
    echo -n "  jq:          "; which jq > /dev/null 2>&1 && echo "OK" || echo "MISSING"
    echo -n "  nsenter:     "; which nsenter > /dev/null 2>&1 && echo "OK" || echo "MISSING"
  '

fi

echo ""
echo "OCI network hooks installed. Run network-proxy-test.sh to verify."
