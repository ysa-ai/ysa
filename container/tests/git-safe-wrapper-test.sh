#!/bin/bash
# git-safe-wrapper-test.sh — Unit tests for git-safe-wrapper.sh blacklist stripping
#
# Tests that the wrapper strips dangerous keys from local .git/config before
# passing control to the real git binary.
#
# Usage: bash container/tests/git-safe-wrapper-test.sh
# Requires: git installed at /usr/bin/git (or override REAL_GIT env var)

set -uo pipefail

PASS=0
FAIL=0
TESTS=0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$SCRIPT_DIR/../git-safe-wrapper.sh"
REAL_GIT="${REAL_GIT:-/usr/bin/git}"

if [ ! -x "$WRAPPER" ]; then
  echo "ERROR: wrapper not found or not executable: $WRAPPER"
  exit 1
fi

if [ ! -x "$REAL_GIT" ]; then
  echo "ERROR: real git not found at $REAL_GIT"
  exit 1
fi

# Create a temp repo for testing
TMPDIR_REPO=$(mktemp -d /tmp/git-wrapper-test-XXXXXX)
trap 'rm -rf "$TMPDIR_REPO"' EXIT

"$REAL_GIT" init "$TMPDIR_REPO" --quiet
"$REAL_GIT" -C "$TMPDIR_REPO" commit --allow-empty -m "init" --quiet

check_stripped() {
  TESTS=$((TESTS + 1))
  local desc="$1"
  local key="$2"
  local value="$3"

  # Inject the dangerous key via the real git binary (bypassing the wrapper)
  "$REAL_GIT" -C "$TMPDIR_REPO" config --local "$key" "$value"

  # Confirm the key was injected
  if ! "$REAL_GIT" -C "$TMPDIR_REPO" config --local "$key" >/dev/null 2>&1; then
    echo "  [$TESTS] SKIP (injection failed for $key)"
    return
  fi

  # Run the wrapper with a harmless command (config --list) so it sanitises the config
  # We run it from the repo directory so it picks up .git/config
  REAL_GIT="$REAL_GIT" bash "$WRAPPER" -C "$TMPDIR_REPO" config --list >/dev/null 2>&1

  # Check if the key was stripped
  echo -n "  [$TESTS] $desc ... "
  if "$REAL_GIT" -C "$TMPDIR_REPO" config --local "$key" >/dev/null 2>&1; then
    echo "FAIL (key still present after wrapper run)"
    FAIL=$((FAIL + 1))
  else
    echo "PASS (key stripped)"
    PASS=$((PASS + 1))
  fi
}

echo "=========================================="
echo " git-safe-wrapper.sh unit tests"
echo "=========================================="
echo ""

# ut-1: core.worktreeConfig stripped
check_stripped "ut-1: core.worktreeConfig is stripped" "core.worktreeConfig" "true"

# ut-2: init.templateDir stripped
check_stripped "ut-2: init.templateDir is stripped" "init.templateDir" "/tmp/evil-tmpl"

# ut-3: submodule.evil.update stripped
check_stripped "ut-3: submodule.evil.update is stripped" "submodule.evil.update" "!touch /tmp/submod-pwned"

# ut-4: blame.ignoreRevsFile stripped
check_stripped "ut-4: blame.ignoreRevsFile is stripped" "blame.ignoreRevsFile" "/tmp/evil-revs"

echo ""
echo "=========================================="
echo " RESULTS: $PASS passed, $FAIL failed out of $TESTS tests"
echo "=========================================="

if [ $FAIL -gt 0 ]; then
  exit 1
else
  exit 0
fi
