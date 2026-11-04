---
diff_hash: 47e22f4e84bb9fc828200f555c5793bd9eaa1b29b9dab8192df838fa881c9de6
reviewed_at: 2026-11-04T10:18:11Z
---

## Summary

Initial commit of the "ticketboard" Claude Code plugin: a Node CLI (`bin/board`), a file-backed store with git worktree/branch/stash management (`lib/store.js`), project-profile detection (`lib/project.js`), a local HTTP API and single-page UI (`lib/server.js`, `ui/index.html`), and five skill docs. No stack marker matched (no package.json/composer.json etc.), so a generic review was applied. SKILL.md files were not reviewed in depth. Main concerns: the localhost API has no CSRF/Host protection while exposing destructive and command-running endpoints, the project test command bypasses the trust gate, and a few unvalidated inputs reach git or the DOM.

## Findings

### Critical (0)

### High (2)
- **plugins/ticketboard/lib/server.js:110** — The local HTTP server has no Origin/Host check and does not require `Content-Type: application/json` (readBody parses any body). Any web page the developer visits can fire "simple" cross-site POST/PUT/PATCH/DELETE requests at http://localhost:4317 (or use DNS rebinding to also read responses). Reachable actions include force-deleting tickets and their worktrees (`DELETE /api/tickets/:id` with `force`), starting branches/worktrees, rewriting plans, and triggering worktree setup commands. *(security)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Binding to 127.0.0.1 does not stop browser-originated requests. Reject requests whose `Host` is not localhost/127.0.0.1:<port>, reject non-GET requests whose `Origin` is present and not the board's own origin, and require `application/json` (which forces a CORS preflight). A per-run random token injected into the served HTML would be stronger.
- **plugins/ticketboard/lib/store.js:496** — `runAllTests` runs `profile.commands.test` from the committed `ticketboard.project.json` without checking `this.trusted()`. `commandHash` only covers copyFiles/setup/dev, so the trust gate does not cover `commands.test`. Pulling a repo or branch whose profile has a malicious test command, then pressing "run all tests" in the UI or running `board test-all`, executes arbitrary shell. *(security)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Include `commands.test` (and `build`, `lint` if they are ever run) in `commandHash`, and refuse to run them when `!this.trusted()`, the same way `bootstrap` does.

### Medium (4)
- **plugins/ticketboard/lib/store.js:672** — The `base` ref is never validated (the `/start` and `POST /api/tickets` bodies, `update()`'s `baseBranch`, and `--base` in the CLI), but it is passed as a positional to `git worktree add ... base` and `git switch -c branch base`. A value starting with `-` is read by git as an option. Later `git log ${base}..${branch}` uses the stored value too. *(security)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Validate the base with `git rev-parse --verify --quiet <base>^{commit}` (and reject a leading `-`), and put `--` or `--end-of-options` before positionals where git supports it.
- **plugins/ticketboard/ui/index.html:240** — Plan and grill markdown is rendered with `marked` and raw HTML is escaped, but link hrefs are not sanitized. A plan containing `[x](javascript:...)` (plans can be imported from external sources and shared) runs script in the board's origin on click, and that origin has full API access. The marked script is also loaded from a CDN without a Subresource Integrity hash. *(security)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Override the `link`/`image` renderer to allow only http(s)/mailto/relative URLs (or sanitize with DOMPurify), and add `integrity`/`crossorigin` to the CDN script, or vendor it.
- **plugins/ticketboard/lib/store.js:235** — Ticket id allocation is a non-atomic read-modify-write on `.board/config.json` (`c.nextId`, then `saveConfig`). The web server and a Claude/CLI session run concurrently by design, so two creates can get the same id; `create()` then overwrites the other ticket's `ticket.json`, plan and grill log. Separately, `localConfig()` (line 144) writes the config during plain reads, which widens the race. *(correctness)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Allocate ids with an exclusive create (`mkdirSync` of the ticket dir without `recursive`, or `openSync(..., 'wx')`) and retry with the next id on EEXIST. Move the legacy-config migration out of the read path.
- **plugins/ticketboard/lib/store.js:298** — `delete` with `force` runs `git worktree remove --force` and then `fs.rmSync` on the ticket directory. The comment says only generated untracked files can be present at that point, but with `force` (reachable via the unauthenticated API above) tracked modifications and unpushed commits' working files are also destroyed. The only guard is the UI's typed confirmation. *(correctness)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Make the server-side `force` require an explicit confirmation field (for example the ticket id echoed back), so the safeguard does not live only in the UI. Fix the comment so it matches the `force` behaviour.

### Low (4)
- **plugins/ticketboard/lib/server.js:17** — On bodies over 5 MB, `req.destroy()` is called but the promise is never settled, so the handler hangs and the destroyed connection gives the client no error. *(correctness)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Reject with a "payload too large" error (and respond 413) before destroying.
- **plugins/ticketboard/ui/index.html:240** — `marked.use({renderer})` is called inside `md()`, so it registers the renderer again on every render. Behaviour is unchanged but the extension stack grows. *(maintainability)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Call `marked.use` once at startup.
- **plugins/ticketboard/lib/server.js:36** — The adopt-result mapping `{ changes, commits, files, mainNowOn, movedBranch }` is duplicated in two routes. *(maintainability)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Extract a small helper.
- **plugins/ticketboard/lib/store.js:825** — `currentWork()` falls back to the base branch `'main'` when none is configured. In a `master`-based repo with no profile, the main checkout looks like a feature branch, and `adopt` tries to move `master` itself (it fails safely at `git switch main`, but the message is confusing). Use the same default-base detection as `gitBranches()`/`project.detect`. *(correctness)*
  - status: open
  - dev_reasoning: N/A
  - ai_reasoning: Derive the base from origin/HEAD or an existing main/master/develop branch instead of hardcoding 'main'.

## Reviewed files
- .claude-plugin/marketplace.json
- .gitignore
- plugins/ticketboard/.claude-plugin/plugin.json
- plugins/ticketboard/bin/board
- plugins/ticketboard/lib/project.js
- plugins/ticketboard/lib/server.js
- plugins/ticketboard/lib/store.js
- plugins/ticketboard/ui/index.html (grepped for escaping and rendering paths, not read in full)
- plugins/ticketboard/skills/board/SKILL.md (skimmed)
- plugins/ticketboard/skills/build/SKILL.md (skimmed)
- plugins/ticketboard/skills/resume/SKILL.md (skimmed)
- plugins/ticketboard/skills/setup/SKILL.md (skimmed)
- plugins/ticketboard/skills/ticket/SKILL.md (skimmed)
