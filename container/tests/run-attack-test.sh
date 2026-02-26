#!/bin/bash
# run-attack-test.sh — Run the sandbox security attack test suite
# Usage: bash packages/core/container/run-attack-test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="sandbox-claude"
WORKSPACE="$HOME/.cache/sandbox-attack-test-workspace"
ALLOWED_BRANCH="fix/42"

# ── Setup workspace ──────────────────────────────────────────────────
echo "Setting up test workspace..."
rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE"
git init "$WORKSPACE" --quiet
git -C "$WORKSPACE" commit --allow-empty -m "init" --quiet
echo '{}' > "$WORKSPACE/package.json"
git -C "$WORKSPACE" add -A && git -C "$WORKSPACE" commit -m "add package.json" --quiet

# ── Run attack tests ────────────────────────────────────────────────
echo "Launching attack test in hardened container..."
echo ""

podman run --rm \
  --user 1000:1001 \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt seccomp="$SCRIPT_DIR/../seccomp.json" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --tmpfs /dev/shm:rw,nosuid,nodev,noexec,size=64m \
  --mount type=tmpfs,dst=/output,tmpfs-size=64m,tmpfs-mode=1777 \
  --memory 4g \
  --pids-limit 512 \
  --cpus 2 \
  --ulimit core=0 \
  -e ALLOWED_BRANCH="$ALLOWED_BRANCH" \
  -e GIT_AUTHOR_NAME="Sandbox Agent" \
  -e GIT_AUTHOR_EMAIL="agent@sandbox" \
  -e GIT_COMMITTER_NAME="Sandbox Agent" \
  -e GIT_COMMITTER_EMAIL="agent@sandbox" \
  -v "$WORKSPACE:/workspace:rw" \
  -v "$SCRIPT_DIR/attack-test.sh:/tmp/attack-test.sh:ro" \
  "$IMAGE" \
  -c "bash /tmp/attack-test.sh"

EXIT_CODE=$?

# ── Cleanup ──────────────────────────────────────────────────────────
rm -rf "$WORKSPACE" 2>/dev/null || true

exit $EXIT_CODE
