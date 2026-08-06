# 1st Fire Protection OS

## Writing style (HARD RULE)

**NEVER use em dashes (the "—" character) anywhere, ever.** Not in chat replies,
not in code comments, docs, emails, deck or artifact copy, commit messages, PR
bodies, or any user-facing text. This is absolute and permanent. Use a colon, a
comma, parentheses, or two separate sentences instead. The same goes for en
dashes ("–") in prose; write "to" for ranges. If you are about to type "—", stop
and rewrite the sentence.

## Deployment workflow: ALWAYS merge working branches into `main`

A GitHub Action deploys to the Fly app on every push to `main`. Work that
stays on a feature branch never deploys.

**Rule: every time you create and work off a `claude/*` branch, merge it into
`main` and push `main` when you finish. Do this every single time, without
being asked.** Leaving work on a branch is not "done". It must land on `main`.

This is enforced two ways:

1. **Automatically:** a `Stop` hook (`.claude/settings.json` plus
   `.claude/merge-to-main.sh`) fast-forwards `main` to the current `claude/*`
   branch and pushes at the end of each turn.
2. **Manually as a fallback:** if the hook does not run (e.g. config not yet
   reloaded), do it yourself: `git push origin HEAD:main`.

If `main` has diverged and a fast-forward is rejected, do a real merge
(`git checkout main && git merge <branch> && git push origin main`) and report it.
