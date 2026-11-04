---
name: pr
description: Open the pull request for a built ticketboard ticket, handle reviewers' comments, and clean up after the merge. It pushes the branch, writes a minimal PR description and opens the PR with gh once you confirm. For review comments, it reads them, prepares a fix for each one, and changes nothing until you approve. After the merge it removes the worktree and keeps the ticket and its history, so QA or client changes can reopen it. Use for "/pr", "open a PR for TIX-8", "handle the PR comments", "the PR is merged".
argument-hint: "[ticket id] [open|comments|merged]"
---

# PR

Use the `board` CLI (the plugin's `bin/` is on PATH; if `board` isn't found, use `<this skill's base directory>/../../bin/board`). All git and gh commands run in the ticket's worktree.

**gh or browser.** `board pr-check <id> --json` says whether gh is used (`gh`). It's false when gh isn't installed, or when it's turned off with `board gh off` (e.g. the org doesn't allow GitHub CLI). Without gh, everything that talks to GitHub goes through the user's browser, and nothing new needs org approval:
- you push with plain git;
- they open the PR from a link you give them;
- they paste back the PR URL, and later its merge and its comments.

Never ask them to install gh or to sign it in.

Pick the ticket from the arguments, or with `board which`. Then pick the step:
- An action given in the arguments.
- Otherwise, `board pr <id> --json`:
  - no PR yet: **open**;
  - PR open: **comments**;
  - PR merged: **merged**;
  - PR closed without merge: say so and ask what to do.

## open
1. **Check it's ready:** run `board pr-check <id> --json`.
   - If it's not `ready`, list the `reasons` and stop. Unfinished tasks, a failed or missing `test-all`, or uncommitted work go back to `/ticketboard:build <id>`.
   - The ticket and code reviews already happened during build, so don't redo them here.
2. **Write the description.** Keep it minimal: the `title` from pr-check (`<id>: <ticket title>`), and a body of a few lines on what changed, using pr-check's `body` draft (it's built from the commits) and tightening it. If the repo has a PR template (`.github/pull_request_template.md`), fill in only its required parts, briefly. Don't paste the plan.
3. **Confirm once.** Show the title, body, `<branch> → <base>`, and that it opens **ready for review** (not a draft). Ask with AskUserQuestion: **Push and open the PR** (Recommended), **Edit the description**, or **Cancel**.
4. **Push.** Run `git -C <wt> push -u origin <branch>`. If the push is rejected, stop and say why. Never force-push without asking.
5. **Open the PR.**
   - **gh installed (`gh` true):** write the body to a scratchpad file, then:
     ```
     gh pr create --base <base> --head <branch> --title "<title>" --body-file <file>
     ```
     Run it in `<wt>`, then record the URL it prints: `board pr-record <id> <url>`.
   - **No gh:**
     1. Give them pr-check's `compareUrl`, which opens GitHub's "new pull request" page for `<base>...<branch>`. If it's null (not a GitHub remote), give the branch and base so they can open the PR on their host.
     2. Give them the title and the body, each in its own code block, so they're easy to copy.
     3. Tell them to create it as **ready for review**, not a draft.
     4. Ask them to paste the PR URL once it's open, then run `board pr-record <id> <url>`. They can also paste it in the board's **Open PR** panel, which has the same link, title and description.
6. The card moves to **review**. Tell them reviewers' comments are handled with `/ticketboard:pr <id>` (or `/ticketboard:resume <id>`).

## comments
Reviewers' comments are **never changed without approval**, not even small ones.
1. **Read them.** Without gh, ask them to paste the comments from the PR page: the file and line, who wrote it, and the text. Several at once is fine. With gh:
   ```
   gh pr view <pr> --json reviews,comments,reviewDecision
   gh api repos/{owner}/{repo}/pulls/<n>/comments
   ```
   Skip comments that are resolved or already answered by a later commit.
2. **Prepare a solution for each one, changing no files.** Read the code each comment points at and work out the fix. Also check it against the ticket's plan:
   - **Fits the plan:** a bug, a naming issue, or a missed edge case.
   - **Changes the plan:** new scope or a different decision. Mark it as such, since it may belong in a reopened round instead.
3. **Ask for approval.** Show a numbered list: the comment (who, where, a short quote) and the proposed fix in one or two lines. Ask with AskUserQuestion (multiSelect) which fixes to apply. Options: **All of them**, individual items, or **None, I'll reply myself**. Comments that disagree with the plan get their own question first.
4. **Apply only the approved fixes**, in the worktree, following the build skill's rules for each fix: ticket review, then code review (self first, then the repo's review hook or the review skill), then commit with the `commit-message` skill and `-F`. Run the affected task tests and `board test-all <id>`.
   - **`none` commit mode** (`board next <id> --json` shows `commitMode`): don't commit. Stage the fixed files by name, review them, and hand over the same way as build's `none` step. Push after they've committed.
5. **Push** (`git -C <wt> push`). Then the replies:
   - **With gh:** replying posts on their behalf, so ask first. Show the reply text for each fixed comment (e.g. "Fixed in abc1234"), then post the ones they approve.
   - **Without gh:** give the reply for each comment so they can paste it on GitHub themselves.
6. `board note <id> "PR #<n>: fixed <comments>; waiting on <x>"`.

## merged
1. Confirm the merge.
   - **With gh:** `board pr <id>`.
   - **Without gh:** the board can't check GitHub, so ask them whether it's merged. On yes, run `board pr-state <id> merged`. They can also use the **Mark merged** button on the board.
2. Ask with AskUserQuestion: **Clean up now** (Recommended: remove the worktree, keep the local branch), **Clean up and delete the local branch**, or **Not now**.
3. Run `board cleanup <id>` (add `--delete-branch` if they picked that). It refuses if the worktree has uncommitted work or commits no remote has; show what it lists.
4. Say the ticket is done and that its plan, tasks, PR and history stay on the board. If QA or the client finds something later, `/ticketboard:ticket reopen <id> "<what they found>"` starts a new round with full context.
