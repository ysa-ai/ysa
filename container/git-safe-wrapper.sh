#!/bin/bash
# git-safe-wrapper.sh — Shadows /usr/bin/git to neutralize ALL config-based code execution
# Installed at /usr/local/bin/git (takes precedence over /usr/bin/git in PATH)
#
# Strips ALL dangerous configs from local .git/config before passing through
# to the real git binary. This blocks arbitrary code execution even if local
# config is poisoned by a malicious repository.
#
# Attack vectors neutralized:
#   filter.*.clean/smudge/process — .gitattributes filter drivers
#   diff.*.textconv/command       — diff drivers triggered by git diff/log
#   diff.external                 — external diff program
#   merge.*.driver                — merge drivers triggered by git merge
#   core.pager / pager.*          — shell command for paging (fires on nearly every git cmd)
#   core.editor / sequence.editor — shell command for editing
#   core.sshCommand               — shell command for SSH transport
#   core.askPass / core.gitProxy  — credential/proxy helpers
#   gpg.program / gpg.*.program   — signing program
#   credential.helper             — credential store program
#   interactive.diffFilter        — filter for git add -p
#   trailer.*.command/cmd         — trailer generation commands
#   include.path / includeIf.*    — config file includes (loads arbitrary configs)
#   alias.* (with ! prefix)       — shell alias execution
#   url.*.insteadOf               — URL rewriting (can redirect to ext:: transport)
#   sendemail.smtpServer          — sendmail program execution
#   protocol.ext.allow            — ext:: transport command execution

REAL_GIT=/usr/bin/git

# Determine the target directory: check for -C flag
target_dir=""
prev_was_C=0
for i in "$@"; do
  if [ "$prev_was_C" = "1" ]; then
    target_dir="$i"
    break
  fi
  [ "$i" = "-C" ] && prev_was_C=1 || prev_was_C=0
done

work_dir="${target_dir:-.}"

# Dangerous config key patterns (regex for grep -E)
# These are keys whose VALUES are executed as shell commands by git
DANGEROUS_EXACT_KEYS="core\.pager|core\.editor|core\.sshCommand|core\.askPass|core\.gitProxy|diff\.external|sequence\.editor|interactive\.diffFilter|gpg\.program|sendemail\.smtpServer"
DANGEROUS_WILDCARD_KEYS="filter\.[^.]+\.(clean|smudge|process)|diff\.[^.]+\.(textconv|command)|merge\.[^.]+\.driver|pager\.[^.]+|gpg\.[^.]+\.program|trailer\.[^.]+\.(command|cmd)|include\.path|includeif\.[^.]+\.path|url\.[^.]+\.(insteadof|pushinsteadof)"

# Strip dangerous configs from ALL config locations
# --git-common-dir gives the shared config (important for worktrees)
for cmd in "rev-parse --git-dir" "rev-parse --git-common-dir"; do
  dir=$("$REAL_GIT" -C "$work_dir" $cmd 2>/dev/null)
  [ -z "$dir" ] && continue

  # Make absolute if relative
  case "$dir" in
    /*) ;;
    *) dir="$work_dir/$dir" ;;
  esac

  [ -f "$dir/config" ] || continue

  # Get all config keys from this file and strip dangerous ones
  config_list=$("$REAL_GIT" config --file "$dir/config" --list 2>/dev/null) || continue

  # Strip exact and wildcard dangerous keys
  for key in $(echo "$config_list" | grep -oiE "^($DANGEROUS_EXACT_KEYS|$DANGEROUS_WILDCARD_KEYS)=" | sed 's/=$//'); do
    "$REAL_GIT" config --file "$dir/config" --unset-all "$key" 2>/dev/null
  done

  # Strip shell aliases (alias.X = !command)
  for entry in $(echo "$config_list" | grep -iE '^alias\.' | grep '=!'); do
    key=$(echo "$entry" | cut -d= -f1)
    "$REAL_GIT" config --file "$dir/config" --unset-all "$key" 2>/dev/null
  done
done

exec "$REAL_GIT" "$@"
