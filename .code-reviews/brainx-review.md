---
diff_hash: 35200418331c1b52e2a12b6ea51bd707dd0d6a5858c57cacd30e3e9ee2f84896
reviewed_at: 2026-11-04T11:59:29Z
---

## Summary

Adds pull-request and "round" support to ticketboard: `Board.prCheck/recordPr/refreshPr/setPrState/cleanup/reopen/roundsSummary` in `lib/store.js`, matching CLI commands in `bin/board`, API routes in `lib/server.js`, UI buttons/chips in `ui/index.html`, a new `pr` skill, and updates to the build/resume/ticket skills. No stack marker matched (no package.json etc.), so a generic review was applied. Logic is largely sound: PR URLs are validated, cleanup is gated on a merged PR plus `deleteCheck`, and reopen refuses while a worktree exists. Two issues found.

## Findings

### Critical (0)

### High (0)

### Medium (1)
- **plugins/ticketboard/lib/store.js:1087** — `gh()` uses `execFileSync` with no `timeout`, and `refreshPr` runs it from the `GET /api/tickets/:id/pr` route (and the UI "refresh" link). A slow or hung network or an auth prompt blocks the single-threaded board server, freezing every request and UI polling. A GET route also writes ticket state through `setPrState`. *(correctness)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Pass a `timeout` (e.g. 15s) and `maxBuffer` to `execFileSync`, and handle the timeout error as a `gh` error, which `refreshPr` already returns. Consider making refresh a POST since it mutates.

### Low (1)
- **plugins/ticketboard/ui/index.html:341** — `$('#dPrRefresh').onclick` is assigned, then the `if (t.bootstrap)` line does `$('#dBranch').innerHTML += ...`, which re-serializes the element and drops the handler. For tickets with a bootstrap record, "refresh" becomes a dead `href="#"` link that only jumps to the top. *(correctness)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Build the full `#dBranch` HTML first, then assign `onclick` handlers (`dPrRefresh`, `dSetupLink`) after the last `innerHTML` write.

## Reviewed files
- plugins/ticketboard/bin/board
- plugins/ticketboard/lib/server.js
- plugins/ticketboard/lib/store.js
- plugins/ticketboard/ui/index.html
- plugins/ticketboard/skills/build/SKILL.md (skimmed)
- plugins/ticketboard/skills/pr/SKILL.md (skimmed)
- plugins/ticketboard/skills/resume/SKILL.md (skimmed)
- plugins/ticketboard/skills/ticket/SKILL.md (skimmed)
