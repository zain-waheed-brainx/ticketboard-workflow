---
diff_hash: 801c09a32ca0e383af9f38b799e03a84953567cb9a78960d498ffd8090761e35
reviewed_at: 2026-11-04T13:18:16Z
---

## Summary

Replaces the "copy chat command" Open PR / Add PR link buttons with an in-board "Open PR" panel: a readiness check, a never-forced `git push` endpoint (`POST /api/tickets/:id/push`, needs `confirm: true`), copyable title/description, a GitHub compare link, and PR URL recording. Stack: no framework marker matched (plain Node server + vanilla HTML UI), so a generic review was applied. `git push` is spawned with an argv array (no shell injection) and prompts are disabled.

## Findings

### Critical (0)

### High (0)

### Medium (1)
- **plugins/ticketboard/ui/index.html:566** — `renderPrPanel` keeps the previous `prInfo` and the old title/description in the form when the `pr-check` request fails. The `pPush`/`pGitHub` handlers and the copy buttons then act on stale data from another ticket. *(correctness)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Set `prInfo = null` and clear the fields before the fetch, and disable the buttons (or guard the handlers) when it fails. Otherwise a failed check after viewing ticket A can show A's branch, title and compare URL in ticket B's panel.

### Low (1)
- **plugins/ticketboard/lib/store.js:1122** — When the 60s timeout kills the push, `close` fires with `code === null`, so the user sees "Push failed: git exited with null" instead of a timeout message. *(maintainability)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Track a `timedOut` flag set in the timer and report "Push timed out after 60s". Also consider `SIGKILL` or killing the process group, since `ssh` children may outlive `SIGTERM` to git.

## Reviewed files
- .code-reviews/brainx-review.md (deleted, previous review; not reviewed)
- plugins/ticketboard/lib/server.js
- plugins/ticketboard/lib/store.js
- plugins/ticketboard/skills/pr/SKILL.md
- plugins/ticketboard/ui/index.html
