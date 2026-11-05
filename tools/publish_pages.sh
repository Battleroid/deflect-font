#!/bin/sh
# Publish game/ to the gh-pages branch, so Pages serves it at the site root.
#
#   sh tools/publish_pages.sh ["commit message"]
#
# game/ on main is the source of truth. Because it is already committed there, its
# tree object exists in the object database and can simply be re-pointed at as the
# root of a commit on another branch -- no checkout, no copying, and the working
# tree is never touched. Run it from anywhere in the repo.

set -e
cd "$(git rev-parse --show-toplevel)"
MSG=${1:-"Publish the game to Pages"}
BRANCH=gh-pages

if ! git rev-parse --verify -q HEAD >/dev/null; then
  echo "No commits yet." >&2; exit 1
fi

# the tree for game/ exactly as last committed on the current branch
TREE=$(git rev-parse "HEAD:game" 2>/dev/null) || {
  echo "game/ is not committed on $(git rev-parse --abbrev-ref HEAD). Commit it first." >&2
  exit 1
}

if [ -n "$(git status --porcelain -- game)" ]; then
  echo "Warning: game/ has uncommitted changes; publishing the committed version." >&2
fi

if git rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null; then
  PARENT="-p refs/heads/$BRANCH"
else
  PARENT=""
fi

COMMIT=$(git commit-tree "$TREE" $PARENT -m "$MSG")
git update-ref "refs/heads/$BRANCH" "$COMMIT"
git push -f origin "$BRANCH"

echo "Published $TREE as $BRANCH ($COMMIT)."
echo "Pages source should be: branch $BRANCH, folder / (root)."
