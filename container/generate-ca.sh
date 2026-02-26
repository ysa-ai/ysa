#!/bin/bash
# generate-ca.sh — Generate a self-signed CA cert + key for the MITM network proxy.
# Called during `podman build` to bake the CA into the image.
# Output: /opt/proxy/ca.pem (public) + /opt/proxy/ca-key.pem (private)

set -euo pipefail

# When called with an argument, write to that directory (host pre-build step).
# When called without arguments, default to /opt/proxy (inside container build).
PROXY_DIR="${1:-/opt/proxy}"
mkdir -p "$PROXY_DIR"

# Generate CA private key (EC P-256 — fast, small, modern)
openssl ecparam -genkey -name prime256v1 -noout -out "$PROXY_DIR/ca-key.pem"

# Generate self-signed CA certificate (valid 10 years)
openssl req -new -x509 \
  -key "$PROXY_DIR/ca-key.pem" \
  -out "$PROXY_DIR/ca.pem" \
  -days 3650 \
  -subj "/CN=Ysa Sandbox CA/O=Ysa/OU=Network Proxy" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

chmod 644 "$PROXY_DIR/ca.pem"
chmod 640 "$PROXY_DIR/ca-key.pem"
chown root:agent "$PROXY_DIR/ca-key.pem" 2>/dev/null || chmod 644 "$PROXY_DIR/ca-key.pem"

echo "CA cert generated at $PROXY_DIR/ca.pem"
