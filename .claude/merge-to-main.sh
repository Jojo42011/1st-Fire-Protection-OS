#!/usr/bin/env bash
# Auto-merge the current claude/* working branch into main and push.
# Runs from the Stop hook so a push to main triggers the Fly deploy.
# Safe by design: only acts on claude/* branches, only fast-forwards main,
# and never disturbs the working tree (no local checkout of main).

set -uo pipefail

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0

case "$branch" in
  claude/*) ;;
  *) exit 0 ;;  # not a working branch — nothing to merge
esac

# Make sure the branch itself is on the remote first.
git push -u origin "$branch" >/dev/null 2>&1

# Fast-forward main to this branch's tip. Because our branches are cut from
# the latest main and only add commits, this is a clean fast-forward and
# triggers the deploy. If main has diverged it is rejected and left untouched.
if git push origin "HEAD:main" >/dev/null 2>&1; then
  printf '{"systemMessage":"Auto-merged %s -> main and pushed (Fly deploy triggered)."}\n' "$branch"
else
  printf '{"systemMessage":"Pushed %s, but could not fast-forward main (it has diverged). Merge to main manually."}\n' "$branch"
fi

exit 0
