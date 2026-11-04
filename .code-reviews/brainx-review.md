---
diff_hash: 8598a8783cb06110e6dfd88a41c985c758d2100f63d1346918723b1f378e909b
reviewed_at: 2026-11-04T11:02:45Z
---

## Summary

Adds commit validation to the ticketboard store: a new `Board.checkCommit()` that `updateTask` (when `commit` is patched) and `recordCommit` now call, requiring the sha to exist, be on the ticket's branch, and not already be on the base branch. The `build` SKILL.md is updated to require a review before every commit, to treat a hook-blocked commit as "not committed", and to record `git rev-parse HEAD` taken right after a successful commit. The staged diff also deletes the previous `.code-reviews/brainx-review.md` (finalized in the last commit). No stack marker matched (no package.json etc.), so a generic review was applied.

## Findings

### Critical (0)

### High (0)

### Medium (1)
- **plugins/ticketboard/lib/store.js:536** — `checkCommit` does not catch the failure it is written for in `per-task` mode. If a hook blocks task T2's commit, `git rev-parse HEAD` in the worktree returns T1's commit, which is on the ticket branch and not on the base branch, so the check passes and T2 is recorded with T1's sha. *(correctness)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: The comment says it "catches recording HEAD of the wrong checkout after a hook blocked the commit", but it only catches that for a checkout whose HEAD is off the ticket branch or already on base. In per-task mode, also reject a sha already recorded on a different task (`tk.tasks.some(o => o.id !== taskId && o.commit === full)`). In single mode, `recordCommit` could also require that the sha is not the one already recorded for earlier tasks, or that it is newer than the ticket's start.

### Low (2)
- **plugins/ticketboard/lib/store.js:439** — `checkCommit` runs on every `patch.commit`, even when it equals the commit already stored on the task, and it replaces the value with the full sha. Re-sending an already recorded commit after the ticket is merged to base now throws "already on the base branch", and an older short sha stored on a task no longer equals the full sha, which logs a spurious `task-updated` change. *(correctness)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Skip validation when `patch.commit` already equals `x.commit` (or resolves to the same full sha), so idempotent re-records stay no-ops.
- **plugins/ticketboard/lib/store.js:541** — `tryGit` returns `null` for both "not an ancestor" (exit 1) and real errors such as a missing or invalid ref (exit 128). A deleted ticket branch produces the misleading "isn't on branch" message. A base ref that can't be resolved makes the base-branch check fail open without saying so. *(maintainability)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Verify that `refs/heads/<branch>` exists first and give a specific error. Decide on purpose whether an unresolvable base should be skipped, and note it in the comment.

## Reviewed files
- .code-reviews/brainx-review.md (deleted, previous review artifact; not reviewed)
- plugins/ticketboard/lib/store.js
- plugins/ticketboard/skills/build/SKILL.md
