#!/bin/bash
# ── Reading Copilot — Publish to GitHub ──────────────────────────────────────
# Run this once from inside the reading-copilot folder:
#   bash publish_to_github.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

GITHUB_USER="tichen4869"
REPO_NAME="reading-copilot"
DESCRIPTION="Chrome Extension: AI-powered reading sidebar with guided Q&A, interview prep, and article summaries"

echo ""
echo "✦ Reading Copilot — GitHub Publisher"
echo "────────────────────────────────────"

# ── Step 1: initialise git if not already done ────────────────────────────────
if [ ! -d ".git" ]; then
  echo "→ Initialising git repo..."
  git init
  git branch -M main
  git config user.email "ti.chen4869@gmail.com"
  git config user.name "ti"
fi

# ── Step 2: make sure everything is committed ─────────────────────────────────
echo "→ Staging all files..."
git add -A

if git diff --cached --quiet && git log --oneline -1 &>/dev/null; then
  echo "  (nothing new to commit)"
else
  git commit -m "Initial release — Reading Copilot Chrome Extension"
fi

# ── Step 3: create GitHub repo and push ──────────────────────────────────────
if command -v gh &>/dev/null; then
  echo "→ Creating GitHub repo with gh CLI..."
  gh repo create "$REPO_NAME" \
    --public \
    --description "$DESCRIPTION" \
    --source=. \
    --remote=origin \
    --push
  echo ""
  echo "✅ Published! View at: https://github.com/$GITHUB_USER/$REPO_NAME"
else
  echo ""
  echo "gh CLI not found — running manual git push..."
  if git remote get-url origin &>/dev/null; then
    echo "  (remote already set)"
  else
    git remote add origin "https://github.com/$GITHUB_USER/$REPO_NAME.git"
  fi
  echo ""
  echo "→ Please create the repo first at:"
  echo "  https://github.com/new  (name it: $REPO_NAME)"
  echo ""
  echo "→ Then run:  git push -u origin main"
  echo ""
  echo "  OR install gh and re-run:  brew install gh && bash publish_to_github.sh"
fi
