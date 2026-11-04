---
diff_hash: eb5b9be48a19183ff26a6a08f7a27229177633f2d48dea180849801ff55d1645
reviewed_at: 2026-11-04T11:23:04Z
---

## Summary

Updates the `build` skill so commit messages come from the `commit-message` skill (invoked with the worktree path, ticket id and task, ticket id kept in the subject), with the old `<id> <T#>: <task title>` and `<id>: <ticket title>` formats as fallbacks when the skill isn't available. Applies to both `per-task` and `single` commit modes. The staged diff also deletes the previous `.code-reviews/brainx-review.md` (already finalized in the last commit). No stack marker matched (documentation/skill text only), so a generic review was applied.

## Findings

### Critical (0)

### High (0)

### Medium (0)

### Low (0)
- **plugins/ticketboard/skills/build/SKILL.md:53** — (resolved) The per-task example previously suggested inlining a generated, possibly multi-line message in double quotes. Generated text can contain backticks, `$`, or quotes that the shell would expand or break on. *(maintainability)*
  - status: fixed
  - dev_reasoning: N/A
  - ai_reasoning: Fixed. The per-task example now uses `git -C <wt> commit -F <scratchpad>/commit-msg.txt` with an explicit note to never inline the message in `-m "..."`, and the single-mode step also says to commit with `-F <message file>`.

## Reviewed files
- .code-reviews/brainx-review.md (deleted, previous review artifact; not reviewed)
- plugins/ticketboard/skills/build/SKILL.md
