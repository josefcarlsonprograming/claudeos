#!/usr/bin/env bash
# Start a NEW ClaudeOS task in its own isolated git WORKTREE + branch, so every card
# you work on is on its own branch (never on master/main directly).
#
#   bash scripts/new-task.sh <repo> <slug> [initial prompt ...]
#
#   <repo>  a repo path, or just its name under ~ (e.g. CRM, batsonic, biosonic-server)
#   <slug>  short task name, used for the branch (josef/<slug>) and worktree folder
#
# Examples:
#   bash scripts/new-task.sh CRM fix-login
#   bash scripts/new-task.sh batsonic export-csv "Add a CSV export to the reports page"
set -uo pipefail

REPO_ARG="${1:-}"; SLUG="${2:-}"
if [ -z "$REPO_ARG" ] || [ -z "$SLUG" ]; then
  echo "usage: new-task.sh <repo> <slug> [initial prompt ...]"; exit 1
fi
shift 2 || true
PROMPT="${*:-}"

# Resolve the repo dir.
if [ -d "$REPO_ARG/.git" ]; then REPO="$REPO_ARG"
elif [ -d "$HOME/$REPO_ARG/.git" ]; then REPO="$HOME/$REPO_ARG"
else echo "repo not found: '$REPO_ARG' (tried it and ~/$REPO_ARG)"; exit 1; fi
REPO="$(cd "$REPO" && pwd)"
NAME="$(basename "$REPO")"

# Safe branch + worktree names.
SAFE_SLUG="$(printf '%s' "$SLUG" | tr -c 'A-Za-z0-9_-' '-' )"
# Flat name (josef-<slug>, not josef/<slug>): a "josef" branch already exists in some repos,
# and git can't have both a "josef" ref and a "josef/..." ref (file-vs-directory clash).
BRANCH="josef-${SAFE_SLUG}"
WT="$REPO/.claude/worktrees/${SAFE_SLUG}"
SESS="$(printf '%s-%s' "$NAME" "$SAFE_SLUG" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-40)"

mkdir -p "$REPO/.claude/worktrees"

# Create the worktree on a fresh branch (or reuse if it already exists).
if [ -d "$WT" ]; then
  echo "==> worktree already exists: $WT"
else
  echo "==> creating worktree $WT  on branch $BRANCH"
  if ! git -C "$REPO" worktree add -b "$BRANCH" "$WT" 2>/dev/null; then
    # branch may already exist → attach to it
    git -C "$REPO" worktree add "$WT" "$BRANCH"
  fi
fi

# Start (or reuse) a tmux session running Claude in the worktree.
if tmux has-session -t "$SESS" 2>/dev/null; then
  echo "==> tmux session '$SESS' already running"
else
  echo "==> starting Claude in tmux session '$SESS'"
  tmux new-session -d -s "$SESS" -c "$WT" "claude"
  sleep 5
  # Answer the one-time "trust this folder?" prompt if it appears (new worktree dir).
  if tmux capture-pane -t "$SESS" -p 2>/dev/null | grep -qi "trust this folder"; then
    tmux send-keys -t "$SESS" "1"; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 2
  fi
  # Decline the one-time fullscreen-renderer prompt if it appears.
  if tmux capture-pane -t "$SESS" -p 2>/dev/null | grep -qi "fullscreen renderer"; then
    tmux send-keys -t "$SESS" "2"; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 1
  fi
fi

# Optional kickoff prompt (also makes the card appear immediately).
if [ -n "$PROMPT" ]; then
  sleep 1; tmux send-keys -t "$SESS" "$PROMPT"; sleep 1; tmux send-keys -t "$SESS" Enter
fi

echo ""
echo "✅ New task ready"
echo "   repo:     $NAME"
echo "   branch:   $BRANCH"
echo "   worktree: $WT"
echo "   tmux:     $SESS   (attach manually with: tmux attach -t $SESS)"
echo "   → It shows up as its own card in ClaudeOS within ~5s (once it has a first message)."
