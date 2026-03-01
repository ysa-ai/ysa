#!/bin/bash
# container-sandbox-guard.sh — Security hook for Claude Code inside the sandbox container
#
# Paths:
#   /workspace  — worktree (rw)
#   /output     — output directory (rw)
#   /repo.git   — main repo git dir (ro or rw)
#
# Exit 0 = allow, Exit 2 = block (message in stderr)

set -euo pipefail

if ! command -v jq &>/dev/null; then
  echo "BLOCKED: jq is required for sandbox-guard.sh but not found" >&2
  exit 2
fi

CONTEXT_ID="${CONTEXT_ID:-unknown}"
WORKTREE="/workspace"
OUTPUT_DIR="/output"
MAIN_REPO="/repo.git"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# ---------------------------------------------------------------------------
# Sensitive file patterns (blocked for Read, Edit, Write)
# ---------------------------------------------------------------------------
SENSITIVE_PATTERNS='\.env$|\.env\.|credentials|secret|\.key$|\.pem$|\.cert$|\.p12$|id_rsa|id_ed25519'

check_sensitive_path() {
  local filepath="$1"
  if echo "$filepath" | grep -iEq "$SENSITIVE_PATTERNS"; then
    echo "BLOCKED: Access to sensitive file '$filepath' is not allowed in sandboxed mode (task ${CONTEXT_ID})" >&2
    exit 2
  fi
}

check_path_in_scope() {
  local filepath="$1"
  case "$filepath" in
    ${WORKTREE}/*|${OUTPUT_DIR}/*|${MAIN_REPO}/*)
      return 0
      ;;
    *)
      echo "BLOCKED: Path '$filepath' is outside the allowed scope for task ${CONTEXT_ID}" >&2
      exit 2
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Tool-specific checks
# ---------------------------------------------------------------------------
case "$TOOL_NAME" in

  Bash)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

    if echo "$COMMAND" | grep -Eq 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force|-rf|-fr)'; then
      echo "BLOCKED: Destructive 'rm' command not allowed in sandbox (task ${CONTEXT_ID})" >&2
      exit 2
    fi
    if echo "$COMMAND" | grep -Eq 'git\s+push\s+.*--force([^-]|$)'; then
      echo "BLOCKED: 'git push --force' not allowed in sandbox (task ${CONTEXT_ID})" >&2
      exit 2
    fi
    if echo "$COMMAND" | grep -Eq 'git\s+reset\s+--hard'; then
      echo "BLOCKED: 'git reset --hard' not allowed in sandbox (task ${CONTEXT_ID})" >&2
      exit 2
    fi
    if echo "$COMMAND" | grep -Eq 'git\s+checkout\s+\.'; then
      echo "BLOCKED: 'git checkout .' not allowed in sandbox (task ${CONTEXT_ID})" >&2
      exit 2
    fi
    if echo "$COMMAND" | grep -Eq 'git\s+clean\s+-[a-zA-Z]*f'; then
      echo "BLOCKED: 'git clean -f' not allowed in sandbox (task ${CONTEXT_ID})" >&2
      exit 2
    fi
    if echo "$COMMAND" | grep -Eq '^sudo\s'; then
      echo "BLOCKED: 'sudo' not allowed in sandbox (task ${CONTEXT_ID})" >&2
      exit 2
    fi
    if echo "$COMMAND" | grep -Eq 'chmod\s+777'; then
      echo "BLOCKED: 'chmod 777' not allowed in sandbox (task ${CONTEXT_ID})" >&2
      exit 2
    fi
    if echo "$COMMAND" | grep -Eq '(cat|head|tail|less|more|bat)\s+.*\.env'; then
      echo "BLOCKED: Reading .env file content via shell not allowed in sandbox (task ${CONTEXT_ID})" >&2
      exit 2
    fi
    if echo "$COMMAND" | grep -Eq 'cp\s+.*\.env'; then
      echo "BLOCKED: Copying .env files not allowed in sandbox (task ${CONTEXT_ID})" >&2
      exit 2
    fi
    if echo "$COMMAND" | grep -Eq '(~/|/home/agent/)\.claude/(settings\.json|hooks/)'; then
      echo "BLOCKED: Modifying Claude configuration is not allowed in sandbox (task ${CONTEXT_ID})" >&2
      exit 2
    fi

    exit 0
    ;;

  Read)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    check_sensitive_path "$FILE_PATH"
    exit 0
    ;;

  Edit)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    check_sensitive_path "$FILE_PATH"
    check_path_in_scope "$FILE_PATH"
    case "$FILE_PATH" in
      ${MAIN_REPO}/*)
        echo "BLOCKED: Cannot edit files in main repo from sandbox. Work in worktree: ${WORKTREE}" >&2
        exit 2
        ;;
    esac
    exit 0
    ;;

  Write)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    check_sensitive_path "$FILE_PATH"
    check_path_in_scope "$FILE_PATH"
    case "$FILE_PATH" in
      ${MAIN_REPO}/*)
        echo "BLOCKED: Cannot write files in main repo from sandbox. Work in worktree: ${WORKTREE}" >&2
        exit 2
        ;;
    esac
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
