---
name: ticket
description: Work a ticketboard ticket end to end - create it, plan it with grill-me (or import and validate an existing plan), start it on a named branch in a git worktree, reopen a merged ticket for QA or client changes, share, edit or delete it. Use for "/ticket", "new ticket", "plan TIX-3", "start TIX-3", or any request about a ticket on the board. For picking work back up, /ticketboard:resume is the direct command.
argument-hint: "[new|plan|tasks|start|resume|reopen|share|edit|delete] [ticket id] [title or notes]"
---

# Ticket

All state goes through the `board` CLI (the plugin's `bin/` is on PATH; if `board` is not found, use `<this skill's base directory>/../../bin/board`). It works from the main checkout or any worktree and always reads the same `.board/` folder. Never edit `.board/` files by hand. Run `board help` if you need a flag.

If `board list` says there is no board, run `board init`, then continue. If the repo has no `ticketboard.project.json`, mention once that `/ticketboard:setup` makes new worktrees ready to run, but don't block on it.

Pick the action from the arguments. With none: if `board which` names a ticket, run **resume**. Otherwise show `board list` and ask what to do with AskUserQuestion.

## new
1. Infer the title and type (feature, hotfix, enhancement, bugfix or chore) from the request. Ask only if the type is unclear.
2. Run `board suggest "<title>" --type <type>` to get branch names (the `*` line is the recommended name), and `board work --json` to see whether the main checkout has work in progress.
3. Ask one AskUserQuestion about the branch: **Save `<recommended name>` for later** (Recommended), **Create it now**, **Use current branch `<name>`**, or **Pick later**. If `board work` reports `hasWork` and no `owner`, replace "Pick later" with **Move my current work into a worktree** and recommend it. Describe what moves: the branch, N commits and M uncommitted files, and that the main folder goes back to the base branch. Offer the other suggested names, or a custom name or pattern, through "Other". If they give a custom pattern, offer to save it as the default with `board pattern save`.
4. Create the ticket:
   - Save for later: `board new "<title>" --type <type> --desc "<why>" --branch <name>`. The name is reused when work starts.
   - Create it now: the same command plus `--start` (add `--no-worktree` only if asked).
   - Use current branch: `board new "<title>" --type <type> --current`.
   - Pick later: leave out `--branch`.
   - Move my current work: `board new "<title>" --type <type> --adopt`. If the main checkout is on the base branch itself, also pass `--branch <name>` for the new branch. Report what moved. If it says the changes were kept in a stash, show the `git stash apply` line it printed.
5. Offer to plan it now.

## plan <id>
Ask with AskUserQuestion how to plan:
1. **Grill me (new plan)**
2. **Validate an existing plan**: they give a file path or paste it. Save it with `board plan <id> --file <path> --source imported`, then grill only on the gaps.
3. **Use an existing plan as is**: save it as in 2, then `board plan-status <id> validated` and go straight to the **tasks** step.

**Grilling.** Interview the user about every part of the work until you both understand it the same way. Walk each branch of the design, one decision at a time, settling the decisions that others depend on first.
- Before asking, read the ticket (`board show <id>`) and the relevant code. Never ask what the code or the ticket already answers.
- Ask every question with AskUserQuestion, **one at a time**, with 2-4 concrete options specific to this work. Put the one you recommend first, marked "(Recommended)".
- After each answer, log it with `board grill <id> --q "<question>" --a "<answer + one-line why>"`. The board shows it live.
- Every 2-3 answers, and at the end, rewrite the plan with `board plan <id> --source grill --file <tmp file>` so the doc fills in beside the questions. Use a file in your scratchpad, not the repo.
- When validating, first list the gaps, risks and contradictions you found in the imported plan in one short message. Grill only on those.
- If they answer "No preference", take the recommended option, say so in the log answer, and mark it *(Claude's call)* in the plan. It is never approval.
- Stop when nothing important about **what** is left open. Run `board plan-status <id> validated`, show a 5-line summary, then continue straight into the **tasks** step. Don't ask for approval yet: approval covers the plan and its tasks together.

**Plan format.** Keep it short. A builder should be able to work from it a month from now with no other context:
```
# <title>
## Goal / why
## Scope (in / out)
## Decisions (each with a one-line why)
## Approach (steps, files/areas touched)
## Risks & open questions
## Done when
```

## tasks <id>
This step works out **how** the plan gets built, after grilling and before approval. Run it after `plan`, on an imported plan, or again when the board says the plan changed after the tasks were made.

1. **Split.** Read `board show <id>`. Break the plan's Approach into tasks. Each task is a piece of work that can be finished, tested and committed on its own (usually 3-10 tasks).
2. **Work out the how.**
   - **Small ticket** (3 tasks or fewer, or all in one area of the code): write the specs yourself.
   - **Bigger ticket** (more tasks spread over different areas, e.g. backend + frontend): launch one read-only subagent per area, in parallel, in a single message. Give each one the plan, its tasks, and the repo path. Tell it to read the relevant code without editing anything, and to return for each task:
     - the files it will change or add, including its test file
     - the steps, following the patterns already in the code
     - **its test:** the test file to add and the exact command that runs just that test (using the project's test runner), plus one line on what it proves
     - what it depends on
     - any decision the plan doesn't cover
   **Every task gets its own test.** It's defined now (file, command, what it proves) and written first during build, before the task's code. The command must run only that task's test, e.g. `npx jest tests/audit/permissions.test.js` or `php artisan test --filter=AuditExportPermission`, so it can fail before the code and pass after it.
   - Use `test.manual` (with the reason) only when an automated test is really impossible, e.g. a purely visual change. Say so when you show the tasks.
   - If the project has no test runner yet, the first task sets one up (with its own smoke test). Every later task depends on it.
3. **Merge.**
   - **Shared files:** tasks that touch the same files (or the same folder with wildcards) must run in sequence, so add a dependency between them. Mark the rest `parallel: true` only if they have no dependency on each other and no shared files.
   - **New decisions** a subagent or you ran into, i.e. anything that changes **what** gets built (a migration, a new library, an API shape): ask the user grill-style (one AskUserQuestion at a time, recommended option first) and log it with `board grill`. Never decide these silently.
   - **Unclear parallel or sequence cases:** ask one at a time, e.g. "T3 and T4 both touch `routes.ts`: run them in sequence (Recommended) or in parallel?" When in doubt, choose sequence and set `claudesCall: true`.
   - **Build mode:** ask near the end. **One task at a time** (Recommended, cheapest) or **Independent tasks in parallel** (subagents; more tokens).
   - **Run mode:** **Task by task** (Recommended: build pauses after each task so you can check or stop) or **All in one go** (build runs to the end and stops only on a failure or an open decision).
   - **Commit mode:** ask last.
     - **One commit per task** (Recommended): small, reviewable commits, and finished work is safe in git between sessions.
     - **One commit for the whole ticket:** a single clean commit at the end. Until then, finished tasks only exist as uncommitted changes in the worktree, and the repo's commit hooks run once instead of per task.
     - **No commits, I commit myself:** Claude never commits. At the end it stages only the ticket's files, reviews them, and hands over a suggested commit message. Recommend this when the repo's tools generate files that would get committed with the work, e.g. a commit hook that stages everything. Until they commit, the work exists only in the worktree.
4. **Save.** Write JSON to a scratchpad file and run `board tasks-write <id> --file <file>`. This sets the plan to `tasks-ready`. `doneWhen` comes from the plan's "Done when" section.
   ```json
   {
     "buildMode": "sequential",
     "commitMode": "per-task",
     "runMode": "step",
     "tasks": [
       {
         "id": "T1",
         "title": "Add audit:export permission",
         "dependsOn": [],
         "files": ["src/auth/permissions.ts", "tests/auth/audit-export-permission.test.ts"],
         "parallel": false,
         "claudesCall": false,
         "spec": "Steps:\n1. ...\nNotes: follows the pattern in src/auth/roles.ts",
         "test": {
           "command": "npx jest tests/auth/audit-export-permission.test.ts",
           "description": "a role without audit:export gets 403; the compliance role gets 200"
         }
       }
     ],
     "doneWhen": ["A user with audit:export can download a CSV + checksum", "..."]
   }
   ```
5. **Approve.** Show the task list (id, title, after, parallel, test command), the build mode, run mode and commit mode in one short message. Ask: **Approve plan and tasks** (Recommended), **Change a task**, or **Re-split**. On approve, run `board plan-status <id> approved` and offer `/ticketboard:build <id>`. They can also approve with the **Approve plan** button on the board.

## start <id>
1. Run `board branches <id>`. It shows the current branch and the name options; a name saved at creation is listed first as "(planned)".
2. Ask with AskUserQuestion: **New branch** (Recommended) or **Use current branch `<name>`**. If `board work --json` reports `hasWork` and no `owner`, also offer **Move my current work into a worktree** (and recommend it), then run `board adopt <id>` (with `--branch <name>` when on the base branch) and skip steps 3-4.
3. For a new branch, ask a second question with up to 4 options: the generated names (default first), with "Other" for a custom name or a custom `{token}` pattern. If they wrote a custom pattern, ask whether to save it as the default (`board pattern save "<pattern>"`). If they want a branch type that isn't listed (e.g. `release`), run `board type add <name>`.
4. Run `board start <id> --branch <name>` (add `--no-worktree` only if they asked to skip the worktree), or `board start <id> --current`.
5. `board start` also runs worktree setup from `ticketboard.project.json`: it copies files, writes launch.json and runs install. Run it in the background if it may take more than about 2 minutes. If setup failed, show the failing command and the end of the log, help fix it, then run `board bootstrap <id>`.
6. Tell them the worktree path. The work belongs in that worktree. To work on it now or later, in this chat or any other, they type `/ticketboard:resume <id>`.

If the plan isn't `approved`, say so once before starting, but don't block.

## resume [id]
Invoke the `ticketboard:resume` skill with the id and follow it. It is the same as typing `/ticketboard:resume <id>`.

## reopen <id> [what QA or the client found]
For a ticket whose PR is merged (or that is done) when QA finds a bug or the client asks for a change. It's the same ticket, with all its history, in a new round.
1. If the reason isn't in the arguments, ask what they found (a short description is enough).
2. `board show <id>`: if its worktree still exists, run the `ticketboard:pr` skill's **merged** step first, so the old round is cleaned up.
3. Infer the branch type from the reason (`bugfix` for a QA bug, `enhancement` or `feature` for a client change). Ask only if it's unclear.
4. Run `board reopen <id> "<reason>" --type <type>`. This:
   - archives the round's tasks;
   - adds a `## Round N` section to the plan, keeping the old plan as a version;
   - plans a new branch (`…-rN`) from the latest base;
   - moves the card to planning.
5. Carry on as usual with the round's context:
   - **plan:** grill only on the new round's changes and fill in its section. Read the earlier rounds' plan, decisions and tasks first (`board show` lists them), and never re-ask what they settled.
   - **tasks**, approve, **start** (a new worktree on the new branch), then `/ticketboard:build`, then `/ticketboard:pr`.

## share <id>
`board share <id>` copies the plan to `docs/plans/<id>-<slug>.md` (tracked by git) and keeps it synced on every plan save. Tell them to commit that file to share it. `board share <id> --off` stops syncing.

## delete <id>
1. Run `board delete-check <id>`.
2. If it says SAFE: confirm with AskUserQuestion: **Delete ticket + worktree** (Recommended), **Also delete the local branch**, or **Cancel**. Then run `board delete <id>`, adding `--delete-branch` if they picked that option.
3. If it says NOT SAFE: show the unpushed commits or uncommitted files it lists. Ask: **Push first** (Recommended: commit and push from the worktree, then re-check), **Force delete and lose this work**, or **Cancel**. Run `board delete <id> --force` only when they explicitly pick force.
4. Deleting removes the ticket data and the worktree folder. It never removes the main checkout. A shared plan in `docs/plans/` is kept.

## edit <id>
`board set <id> key=value ...` (title, type, priority, labels=a,b, column, description) or `board move <id> <column>`. Every edit is recorded in `board history <id>`.
