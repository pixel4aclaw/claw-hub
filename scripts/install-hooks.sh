#!/data/data/com.termux/files/usr/bin/bash
# Install git hooks by symlinking from scripts/git-hooks/ into .git/hooks/
set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$REPO_ROOT/scripts/git-hooks"
HOOKS_DEST="$REPO_ROOT/.git/hooks"

for hook in "$HOOKS_SRC"/*; do
  name="$(basename "$hook")"
  target="$HOOKS_DEST/$name"
  ln -sf "../../scripts/git-hooks/$name" "$target"
  chmod +x "$hook"
  echo "  installed: .git/hooks/$name"
done

echo "Git hooks installed."
