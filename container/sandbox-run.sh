#!/bin/bash
# sandbox-run.sh -- Launch a hardened sandbox container for an AI agent session
#
# Usage: sandbox-run.sh <worktree> <repo_git_dir> <branch> <mode> <task_id> [command...]
#
# Modes: readonly, readwrite
#
# Mounts: worktree (/workspace), git dir (/repo.git) -- nothing else.
# Session persistence via podman named volume (task-session-{task_id}).
# Log capture via stdout pipe on host (tee).
#
# Required env vars:
#   CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY -- auth for Claude CLI
# Optional env vars:
#   SANDBOX_TIMEOUT    -- container timeout in seconds (default: 3600)
#   LOG_FILE           -- host path for output log (captured via tee)
#   SHADOW_DIRS        -- space-separated workspace-relative dirs to shadow (default: node_modules)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${AGENT_IMAGE:-sandbox-claude}"
SECCOMP_PROFILE="$SCRIPT_DIR/seccomp.json"
TIMEOUT="${SANDBOX_TIMEOUT:-3600}"  # default 1 hour

# -- Args ----------------------------------------------------------------------
if [ $# -lt 5 ]; then
  echo "Usage: $0 <worktree> <repo_git_dir> <branch> <mode> <task_id> [command...]"
  echo "Modes: readonly, readwrite"
  exit 1
fi

WORKTREE="$1"
REPO_GIT="$2"
ALLOWED_BRANCH="$3"
MODE="$4"
TASK_ID="$5"
shift 5
# Extract --allowedTools value (used to write MCP permissions into container settings)
ALLOWED_TOOLS_VALUE=""
PREV_ARG=""
for arg in "$@"; do
  if [ "$PREV_ARG" = "--allowedTools" ]; then
    ALLOWED_TOOLS_VALUE="$arg"
    break
  fi
  PREV_ARG="$arg"
done

# Build properly shell-quoted args string (handles parens in --allowedTools values)
QUOTED_ARGS=""
for arg in "$@"; do
  printf -v escaped '%q' "$arg"
  QUOTED_ARGS+=" $escaped"
done

# -- Validate ------------------------------------------------------------------
if [ ! -d "$WORKTREE" ]; then
  echo "ERROR: Worktree not found: $WORKTREE" >&2; exit 1
fi
if [ ! -d "$REPO_GIT" ]; then
  echo "ERROR: Git dir not found: $REPO_GIT" >&2; exit 1
fi
if [ ! -f "$SECCOMP_PROFILE" ]; then
  echo "ERROR: Seccomp profile not found: $SECCOMP_PROFILE" >&2; exit 1
fi

WORKTREE_NAME="$(basename "$WORKTREE")"

# -- Mode-based access control ------------------------------------------------
case "$MODE" in
  readonly)
    REPO_MOUNT="$REPO_GIT:/repo.git:ro"
    SANDBOX_MODE="readonly"
    ;;
  readwrite)
    REPO_MOUNT="$REPO_GIT:/repo.git:rw"
    SANDBOX_MODE="readwrite"
    ;;
  *)
    echo "ERROR: Unknown mode '$MODE'. Use: readonly, readwrite" >&2
    exit 1
    ;;
esac

# -- Host git identity --------------------------------------------------------
GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-$(git config user.name 2>/dev/null || echo "Sandbox Agent")}"
GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-$(git config user.email 2>/dev/null || echo "agent@sandbox")}"
GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}"
GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"

# -- Session volume ------------------------------------------------------------
# SESSION_VOLUME can be overridden by caller (e.g. to reuse session across refine runs)
SESSION_VOLUME="${SESSION_VOLUME:-task-session-${TASK_ID}}"
podman volume exists "$SESSION_VOLUME" 2>/dev/null || podman volume create "$SESSION_VOLUME" >/dev/null

# -- mise installs volume ------------------------------------------------------
# Pre-populated at project settings save time (not at task launch).
# MISE_VOLUME is set by the caller; defaults to mise-installs for single-project setups.
MISE_VOLUME="${MISE_VOLUME:-mise-installs}"

# -- Shadow volumes (platform-specific build artifacts) ------------------------
# SHADOW_DIRS is a space-separated list of workspace-relative dirs to shadow with
# per-task named volumes.  Default: node_modules (backward compatible).
SHADOW_MOUNTS=""
FIRST_SHADOW=1
for dir in ${SHADOW_DIRS:-node_modules}; do
  if [ "$FIRST_SHADOW" = "1" ] && [ -n "${DEP_CACHE_VOLUME:-}" ]; then
    vol="${DEP_CACHE_VOLUME}"
  else
    vol="shadow-$(echo "$dir" | tr '/' '-')-${TASK_ID}"
  fi
  FIRST_SHADOW=0
  podman volume exists "$vol" 2>/dev/null || podman volume create "$vol" >/dev/null
  SHADOW_MOUNTS="$SHADOW_MOUNTS --mount type=volume,src=$vol,dst=/workspace/$dir"
done

# -- Git worktree pointer ------------------------------------------------------
# Write container-internal git pointers from the host before container starts,
# so the container sees the correct paths without needing write access to them.
echo "gitdir: /repo.git/worktrees/$WORKTREE_NAME" > "$WORKTREE/.git"
echo "/workspace/.git" > "$REPO_GIT/worktrees/$WORKTREE_NAME/gitdir"

# -- Network policy -----------------------------------------------------------
NETWORK_POLICY="${NETWORK_POLICY:-none}"
NETWORK_FLAGS=""
PROXY_ENV_FLAGS=""

if [ "$NETWORK_POLICY" = "strict" ] || [ "$NETWORK_POLICY" = "custom" ]; then
  NETWORK_FLAGS="--annotation network_policy=$NETWORK_POLICY"
  PROXY_URL="http://${TASK_ID}:x@host.containers.internal:3128"
  PROXY_ENV_FLAGS="-e HTTP_PROXY=$PROXY_URL -e HTTPS_PROXY=$PROXY_URL -e http_proxy=$PROXY_URL -e https_proxy=$PROXY_URL -e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ysa-proxy-ca.crt -e NODE_USE_ENV_PROXY=1 -e NODE_NO_WARNINGS=1"
  if [ -n "${NO_PROXY:-}" ]; then
    PROXY_ENV_FLAGS="$PROXY_ENV_FLAGS -e NO_PROXY=$NO_PROXY -e no_proxy=$NO_PROXY"
  fi
fi

# -- Audit log (to stderr, captured by caller) ---------------------------------
echo "=== Sandbox Audit Log ===" >&2
echo "Mode: $SANDBOX_MODE" >&2
echo "Task: $TASK_ID" >&2
echo "Branch: $ALLOWED_BRANCH" >&2
echo "Worktree: $WORKTREE" >&2
echo "Network: $NETWORK_POLICY" >&2
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
echo "Timeout: ${TIMEOUT}s" >&2
echo "Args:$QUOTED_ARGS" >&2
echo "=========================" >&2

# -- Runtime version checks ----------------------------------------------------
podman_ver=$(podman version --format '{{.Client.Version}}' 2>/dev/null || echo "unknown")
runtime_ver=$(podman info --format '{{.Host.OCIRuntime.Name}} {{.Host.OCIRuntime.Version}}' 2>/dev/null | head -1 || echo "unknown")
echo "Podman: $podman_ver, Runtime: $runtime_ver" >&2

# -- Progress helper ----------------------------------------------------------
progress() {
  if [ -n "${LOG_FILE:-}" ]; then
    printf '{"type":"system","subtype":"progress","message":"%s"}\n' "$1" >> "$LOG_FILE"
  fi
}

# -- Log capture setup ---------------------------------------------------------
if [ -n "${LOG_FILE:-}" ]; then
  TEE_CMD="tee -a $LOG_FILE"
else
  TEE_CMD="cat"
fi

# -- Log monitor (background -- watches for max_turns / result) ----------------
MONITOR_PID=""
SETTINGS_TMP=""
cleanup_monitor() {
  if [ -n "$MONITOR_PID" ]; then
    kill "$MONITOR_PID" 2>/dev/null || true
    wait "$MONITOR_PID" 2>/dev/null || true
  fi
  rm -f "${SETTINGS_TMP:-}"
  # Always restore host-side git worktree pointer so git prune doesn't orphan it
  if [ -d "$REPO_GIT/worktrees/$WORKTREE_NAME" ]; then
    echo "gitdir: $REPO_GIT/worktrees/$WORKTREE_NAME" > "$WORKTREE/.git"
    echo "$WORKTREE/.git" > "$REPO_GIT/worktrees/$WORKTREE_NAME/gitdir"
  fi
}
trap cleanup_monitor EXIT

if [ -n "${LOG_FILE:-}" ]; then
  # Record existing line count so continue/refine sessions don't re-trigger
  # on "result" events from previous runs in the same log file.
  INITIAL_LINES=0
  if [ -f "$LOG_FILE" ]; then
    INITIAL_LINES=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
  fi
  # Configurable log patterns -- override via env to support different providers
  MAX_TURNS_PATTERN="${MAX_TURNS_GREP_PATTERN:-^{.*\"subtype\":\"error_max_turns\"}"
  if [ -n "${RESULT_GREP_PATTERN:-}" ]; then
    RESULT_PATTERN="$RESULT_GREP_PATTERN"
  else
    RESULT_PATTERN='^{"type":"result"'
  fi
  (
    while true; do
      NEW_CONTENT=$(tail -n +$((INITIAL_LINES + 1)) "$LOG_FILE" 2>/dev/null || true)
      if echo "$NEW_CONTENT" | grep -q "$MAX_TURNS_PATTERN" 2>/dev/null; then
        sleep 2
        podman stop "sandbox-${TASK_ID}" >/dev/null 2>&1 || true
        break
      fi
      # Stop container once the agent outputs a result -- the CLI may do
      # post-session telemetry that can hang behind the proxy.
      if echo "$NEW_CONTENT" | grep -q "$RESULT_PATTERN" 2>/dev/null; then
        sleep 3
        podman stop "sandbox-${TASK_ID}" >/dev/null 2>&1 || true
        break
      fi
      sleep 1
    done
  ) &
  MONITOR_PID=$!
fi

# -- Auth env vars for container -----------------------------------------------
# AGENT_AUTH_ENV_FLAGS is pre-built by the caller (e.g. "-e ANTHROPIC_API_KEY")
# Fall back to Claude defaults if not set (backward compat).
if [ -n "${AGENT_AUTH_ENV_FLAGS+x}" ]; then
  AUTH_ENV_FLAGS="${AGENT_AUTH_ENV_FLAGS}"
else
  AUTH_ENV_FLAGS=""
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    AUTH_ENV_FLAGS="-e ANTHROPIC_API_KEY"
  fi
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    AUTH_ENV_FLAGS="$AUTH_ENV_FLAGS -e CLAUDE_CODE_OAUTH_TOKEN"
  fi
fi

# -- Generate read-only settings.json on host --------------------------------
# settings.json is mounted :ro so the agent cannot modify the hook reference.
# Claude Code does not write to settings.json during normal operation (confirmed).
# ALLOWED_TOOLS injection is best-effort: if jq is unavailable, the --allowedTools
# CLI flag already enforces restrictions and the injection is redundant.
SETTINGS_TMP=$(mktemp)
if [ -n "$ALLOWED_TOOLS_VALUE" ] && command -v jq >/dev/null 2>&1; then
  TOOLS_JSON=$(echo "$ALLOWED_TOOLS_VALUE" | tr ',' '\n' | jq -R . | jq -s . 2>/dev/null || echo '[]')
  jq --argjson t "$TOOLS_JSON" \
    'if ($t | length) > 0 then .permissions.allow = $t else . end' \
    "$SCRIPT_DIR/claude-settings.json" > "$SETTINGS_TMP" 2>/dev/null \
    || cp "$SCRIPT_DIR/claude-settings.json" "$SETTINGS_TMP"
else
  cp "$SCRIPT_DIR/claude-settings.json" "$SETTINGS_TMP"
fi

progress "Starting container (network: $NETWORK_POLICY)..."

# -- Interactive mode -----------------------------------------------------------
# INTERACTIVE=1: attach stdin/tty, pipe output to terminal AND log file.
# Default 0 = headless (unchanged behaviour).
INTERACTIVE_FLAGS=""
if [ "${INTERACTIVE:-0}" = "1" ]; then
  INTERACTIVE_FLAGS="-i -t"
fi

# -- Launch container ----------------------------------------------------------
CONTAINER_NAME="sandbox-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
EXTRA_LABEL_FLAGS=""
for kv in ${EXTRA_LABELS:-}; do
  EXTRA_LABEL_FLAGS="$EXTRA_LABEL_FLAGS --label $kv"
done
podman run --rm \
  $INTERACTIVE_FLAGS \
  --name "$CONTAINER_NAME" \
  --label "task=${TASK_ID}" \
  $EXTRA_LABEL_FLAGS \
  --userns=keep-id \
  --network slirp4netns \
  --add-host host.containers.internal:host-gateway \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt seccomp="$SECCOMP_PROFILE" \
  --security-opt mask=/proc/kcore \
  --security-opt mask=/proc/kallsyms \
  --security-opt mask=/proc/timer_list \
  --security-opt mask=/proc/sched_debug \
  --read-only \
  --tmpfs /tmp:rw,nosuid,size=256m \
  --tmpfs /dev/shm:rw,nosuid,nodev,noexec,size=64m \
  --memory 4g \
  --pids-limit 512 \
  --cpus 2 \
  --ulimit core=0 \
  --timeout "$TIMEOUT" \
  -e ALLOWED_BRANCH="$ALLOWED_BRANCH" \
  -e AGENT_BINARY="${AGENT_BINARY:-claude}" \
  -e AGENT_INIT_SCRIPT \
  -e AGENT_PROMPT_FLAG="${AGENT_PROMPT_FLAG:--p}" \
  $AUTH_ENV_FLAGS \
  $PROXY_ENV_FLAGS \
  $NETWORK_FLAGS \
  -e PROMPT_URL="${PROMPT_URL:-}" \
  -e PROMPT_TOKEN="${PROMPT_TOKEN:-}" \
  ${EXTRA_POD_ENV:-} \
  -e ALLOWED_TOOLS="$ALLOWED_TOOLS_VALUE" \
  -e INTERACTIVE="${INTERACTIVE:-0}" \
  -e ENABLE_TOOL_SEARCH=false \
  -e GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Sandbox Agent}" \
  -e GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-agent@sandbox}" \
  -e GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-Sandbox Agent}" \
  -e GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-agent@sandbox}" \
  -e MISE_DATA_DIR=/home/agent/.local/share/mise \
  -v "$WORKTREE:/workspace:rw" \
  $SHADOW_MOUNTS \
  -v "$REPO_MOUNT" \
  --tmpfs /home/agent:rw,nosuid,nodev,size=256m,mode=777 \
  --mount "type=volume,src=${SESSION_VOLUME},dst=/home/agent/.claude" \
  --mount "type=volume,src=${MISE_VOLUME},dst=/home/agent/.local/share/mise/installs" \
  -v "$SETTINGS_TMP:/home/agent/.claude/settings.json:ro" \
  "$IMAGE" \
  -c "
    # Progress helper (JSON to stdout -> tee -> LOG_FILE)
    _progress() { printf '{\"type\":\"system\",\"subtype\":\"progress\",\"message\":\"%s\"}\\n' \"\$1\"; }

    # Remove mise from the tmpfs so the agent cannot call or reinstall it.
    # --tmpfs /home/agent copies image content into the tmpfs (Podman behaviour),
    # so the binary is present at startup and must be explicitly removed here.
    rm -f /home/agent/.local/bin/mise 2>/dev/null || true

    # Provider-specific init (settings files, config, onboarding bypass, etc.)
    # AGENT_INIT_SCRIPT is set by the caller; falls back to Claude defaults if unset.
    if [ -n \"\${AGENT_INIT_SCRIPT:-}\" ]; then
      eval \"\$AGENT_INIT_SCRIPT\"
    else
      if [ ! -f /home/agent/.claude/settings.json ] && [ -f /etc/claude-defaults/settings.json ]; then
        cp /etc/claude-defaults/settings.json /home/agent/.claude/settings.json
      fi
      if [ -f /home/agent/.claude.json ]; then
        jq '.hasCompletedOnboarding = true | .projects[\\\"/workspace\\\"].hasTrustDialogAccepted = true' /home/agent/.claude.json > /tmp/cj.json 2>/dev/null && cp /tmp/cj.json /home/agent/.claude.json && rm -f /tmp/cj.json
      else
        echo '{\"hasCompletedOnboarding\":true,\"projects\":{\"/workspace\":{\"hasTrustDialogAccepted\":true}}}' > /home/agent/.claude.json
      fi
    fi

    # Activate pre-installed runtimes. Binaries were installed into the
    # mise-installs volume by the pre-start container. mise is not present here.
    _bin_paths_file=/home/agent/.local/share/mise/installs/.bin-paths
    if [ -s \"\$_bin_paths_file\" ]; then
      export PATH=\"\$(cat \"\$_bin_paths_file\"):\$PATH\"
    fi
    _tool_env_file=/home/agent/.local/share/mise/installs/.tool-env
    if [ -s \"\$_tool_env_file\" ]; then
      . \"\$_tool_env_file\"
    fi

    AGENT_BIN=\"\${AGENT_BINARY:-claude}\"

    # Prompt handling: -p means args are self-contained; --resume without -p fetches prompt from PROMPT_URL
    case \"$QUOTED_ARGS\" in
      *-p\ *)
        _progress 'Starting agent...'
        \$AGENT_BIN $QUOTED_ARGS
        ;;
      *)
        if [ \"\${INTERACTIVE:-0}\" = \"1\" ]; then
          \$AGENT_BIN $QUOTED_ARGS
        elif [ -n \"\$PROMPT_URL\" ]; then
          _progress 'Fetching prompt...'
          PROMPT=\$(curl --max-time 10 --connect-timeout 5 -sf -H \"Authorization: Bearer \$PROMPT_TOKEN\" \"\$PROMPT_URL\")
          if [ -z \"\$PROMPT\" ]; then
            echo 'ERROR: Failed to fetch prompt from PROMPT_URL' >&2
            exit 1
          fi
          _progress 'Starting agent...'
          \$AGENT_BIN \${AGENT_PROMPT_FLAG:--p} \"\$PROMPT\" $QUOTED_ARGS
        else
          echo 'ERROR: No prompt provided (use -p arg or set PROMPT_URL)' >&2
          exit 1
        fi
        ;;
    esac
  " 2>&1 | $TEE_CMD

EXIT_CODE=${PIPESTATUS[0]}

echo "" >&2
echo "Finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
echo "Exit code: $EXIT_CODE" >&2

exit $EXIT_CODE
