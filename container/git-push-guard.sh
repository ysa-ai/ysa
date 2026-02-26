#!/bin/bash
# git-push-guard.sh — Wraps git to intercept push commands
# Ensures the agent can only push to ALLOWED_BRANCH
# Install as a git wrapper: git config --global alias.push '!git-push-guard.sh'
# Or use as a pre-push hook

set -euo pipefail

# This script is called as a pre-push hook
# stdin receives: <local ref> <local sha> <remote ref> <remote sha>

ALLOWED="${ALLOWED_BRANCH:-}"

if [ -z "$ALLOWED" ]; then
  echo "BLOCKED: ALLOWED_BRANCH not set — no pushes permitted" >&2
  exit 1
fi

while read -r local_ref local_sha remote_ref remote_sha; do
  # Extract branch name from refs/heads/branch-name
  branch="${remote_ref#refs/heads/}"

  if [ "$branch" != "$ALLOWED" ]; then
    echo "BLOCKED: Push to branch '$branch' denied. Only '$ALLOWED' is allowed." >&2
    exit 1
  fi
done

exit 0
