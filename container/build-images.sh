#!/bin/bash
# Build all sandbox container images.
# Usage: bash container/build-images.sh [--ca-dir <path>]
#
# Images built:
#   sandbox-claude  — unified sandbox with Claude Code CLI (AGENT=claude)
#   sandbox-mistral — unified sandbox with Mistral Vibe CLI (AGENT=mistral)
#   sandbox-proxy   — MITM proxy for strict network policy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CA_DIR="${CA_DIR:-.ysa/proxy-ca}"

echo "==> Generating CA certificate..."
bash "$SCRIPT_DIR/generate-ca.sh" "$SCRIPT_DIR"

mkdir -p "$CA_DIR"
cp "$SCRIPT_DIR/ca.pem" "$CA_DIR/ca.pem"
cp "$SCRIPT_DIR/ca-key.pem" "$CA_DIR/ca-key.pem"
chmod 644 "$CA_DIR/ca.pem"
chmod 600 "$CA_DIR/ca-key.pem"

echo "==> Building sandbox-claude (AGENT=claude)..."
podman build -t sandbox-claude --build-arg AGENT=claude \
  -f "$SCRIPT_DIR/Containerfile" "$SCRIPT_DIR/"

echo "==> Building sandbox-mistral (AGENT=mistral)..."
podman build -t sandbox-mistral --build-arg AGENT=mistral \
  -f "$SCRIPT_DIR/Containerfile" "$SCRIPT_DIR/"

echo "==> Building sandbox-proxy..."
podman build -t sandbox-proxy \
  -f "$SCRIPT_DIR/Containerfile.proxy" "$SCRIPT_DIR/"

echo "==> Cleaning up..."
rm -f "$SCRIPT_DIR/ca-key.pem" "$SCRIPT_DIR/ca.pem"
podman rm -f ysa-proxy 2>/dev/null || true
podman image prune -f

echo "==> Done."
