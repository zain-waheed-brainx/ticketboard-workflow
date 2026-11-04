---
name: build
description: Build an approved ticketboard ticket task by task in its worktree. Runs each task from its spec, tests it, reviews and commits it (one commit per task, or one for the whole ticket, as chosen), and ticks it off; independent tasks run in parallel subagents when the ticket's build mode says so. Runs task by task (pausing after each) or all in one go, as chosen; you can stop and resume later. Use for "/build", "build TIX-8", "start coding the ticket", "do the next task".
argument-hint: "[ticket id] [all|step]"
---

# Build

Use the `board` CLI (the plugin's `bin/` is on PATH; if `board` isn't found, use `<this skill's base directory>/../../bin/board`).

## 1. Get ready
1. **Ticket:** use the id from the arguments. Otherwise use `board which`, or ask with AskUserQuestion from `board resumable --json`.
2. **Plan status:** if it isn't `approved`, say so.
   - `tasks-ready`: ask to approve now (`board plan-status <id> approved`).
   - No tasks yet: run the **tasks** step of the `ticketboard:ticket` skill first. Don't build without tasks.
   - Tasks marked STALE: redo the tasks step.
3. **Started?** If the ticket hasn't been started (no branch), run the `ticketboard:ticket` skill's **start** step. That covers "move my current work into a worktree" too.
4. **Folder:** run `board prepare <id> --json` and handle its statuses exactly as `ticketboard:resume` does. Move into the returned `worktree`, or use absolute paths there. Every edit, test and commit for this ticket happens in that folder.
5. **Context:** run `board show <id>`. It has the plan, decisions, tasks, the latest note, and the project's dev and test commands.

## 2. Loop
Repeat until `board next <id> --json` reports `allDone`.

1. **Get the batch.** Run `board next <id> --json` and take its `batch`. It's one task, or several when the build mode is `parallel` and those tasks are independent with no shared files.
2. **Mark started.** For each task in the batch: `board task <id> <T#> status=doing`.
3. **Do the work, test first.** For each task:
   1. **Write the test.** Create the task's test exactly as its `test` describes. Don't write any of the task's code yet.
   2. **Run it before the code:** `board test <id> <T#> --before`. It must **fail**.
      - If it already passes, it doesn't test the new behaviour: fix the test and run it again.
      - If it fails for the wrong reason (a syntax error, or the test runner can't start), fix that first. It should fail because the feature is missing.
   3. **Write the code**, following the task's `spec` and the plan's decisions.
   4. **Run it after the code:** `board test <id> <T#>`. It must **pass**. If it fails, fix the code (not the test, unless the test itself was wrong; then say so). If you can't get it to pass, set the task back to `todo` with a note and stop to ask.
   - Tasks with a `manual` test: describe how to check it by hand, ask the user to confirm it works, then use `force=true` when marking it done.

   **Several tasks (parallel):** launch one subagent per task in a single message, all working in the same worktree. Give each one:
   - the worktree path
   - its task's spec, test and file list
   - the relevant plan decisions
   - these four steps

   Tell each one to change **only its own files**, not to commit, and to report the result of its `--before` run, what it changed, and anything it couldn't do. When they're all back, run each task's after-run (`board test <id> <T#>`) yourself, one at a time.
4. **Self-review, every task, in both commit modes.** Review the task's work yourself, without any review skill. The review skill or hook only runs afterwards, at commit time.
   - Read the whole diff (`git -C <worktree> diff`, plus new files).
   - Check it against the task's spec and the plan's decisions: bugs, missed edge cases, error handling, and leftover debug code.
   - A file outside the task's list is only fine if the change clearly belongs to that task.
   - Run lint if the project has it.
   - Fix what you find and re-run the task's test (`board test <id> <T#>`).

   `board task <id> <T#> status=done` refuses until the task's after-run has passed.
5. **Review, then commit, following `commitMode`** (from `board next <id> --json`). A commit always comes after your self-review (step 4) and then a review that passed. In `per-task` mode that's every task. In `single` mode it happens once, at the end (section 3), on the whole ticket's changes.
   - **Review.** Never skip or bypass hooks (`--no-verify` is not allowed).
     - **The repo's commit hook runs a review** (e.g. the brainx code-review pre-commit hook): that review is the gate. Just commit, and handle a block as below.
     - **No review hook:** review the staged diff yourself before committing, using the first of these that's available:
       1. the `brainx:code-review` skill. It writes `.code-reviews/brainx-review.md`. Without the hook nothing enforces it, so you do: every finding must be fixed, or skipped or ignored with a reason the user agreed to, before you commit;
       2. the `code-review` skill;
       3. reading the diff for bugs against the task's spec.
     - Fix what the review finds and re-run the task's test (`board test <id> <T#>`) after any fix.
   - **A blocked commit didn't happen.** If a hook blocks the commit, fix the findings (or resolve them the way the hook asks), re-stage and commit again. Repeat until the commit goes through. If you can't resolve a finding, stop and ask.
   - **Commit message:** stage the files first, then write the message with the `commit-message` skill if it's available. Invoke it with the worktree path, the ticket id and the task (e.g. `<wt> TIX-8 T2: <task title>`), so it reads that worktree's staged diff and log, and keep the ticket id in the subject. Use only the message text it returns, and run the commit yourself as below. If the skill isn't available, use `<id> <T#>: <task title>`.
   - **Record only the commit that went through:** take the sha with `git -C <wt> rev-parse HEAD` right after a successful commit in the worktree. The board refuses a sha that isn't on the ticket's branch or that the base branch already has.
   - **`per-task`:** commit each task on its own, then record it.
     ```
     git -C <wt> add <that task's files, including its test>
     git -C <wt> commit -F <scratchpad>/commit-msg.txt
     ```
     Write the message to a file in your scratchpad and commit with `-F`, never inline in `-m "..."`: generated text can hold quotes, backticks or `$` that the shell would break on.
     `board task <id> <T#> status=done commit=$(git -C <wt> rev-parse HEAD)`
   - **`single`:** don't commit and don't run the review skill yet. Your self-review (step 4) is the only review per task. Just record `board task <id> <T#> status=done`. The changes stay in the worktree. Mention once that, until the final commit, this work exists only as uncommitted changes there (the board's delete check will flag them as unsaved).
6. **Save a note.** `board note <id> "<T# done: what changed; next: T#; gotchas>"`.
7. **Pause or carry on, following the run mode.** Use `all` or `step` from the arguments if given (it applies to this run only). Otherwise use `runMode` from `board next <id> --json`.
   - **`step`:** ask with AskUserQuestion: **Continue with `<next task>`** (Recommended), **Run the rest in one go**, **Stop here**, or **Change something first**. "Run the rest in one go" switches this run to `all`. On stop, the note above is where `/ticketboard:resume` picks up.
   - **`all`:** go straight to the next batch with no question. After each task, give a one-line progress update (e.g. `T3 done (abc1234), 3/6`).
   - **Either mode:** always stop and ask when tests fail and you can't fix them, when a task needs a decision the plan doesn't cover, or when a change would land outside the ticket's files.

## Rules
- **Follow the plan.** A task that turns out to need a decision the plan doesn't cover goes back to the user (one AskUserQuestion). Mark it in the note.
- **Never skip a task silently.** To skip one, ask first, then `board task <id> <T#> status=skipped note="<why>"`.
- **Don't touch the main checkout or other tickets' worktrees.**

## 3. Done
When every task is done:
1. **Run every test together:** `board test-all <id>`. It runs each task's test in order, then the project's full test command. Everything must pass. A test that passed on its own but fails together usually means two tasks interfere with each other: find out why, fix it (that's work on the task that caused it), and run `test-all` again. If you can't fix it, stop and ask. Don't commit or report "ready" with failing tests.
2. **`single` commit mode:** make the one commit now, with the same review-then-commit rules as step 5 of the loop.
   - Run `git -C <wt> add -A` (check `git status` first, so only this ticket's work goes in).
   - Self-review the whole ticket's staged diff first, without a skill. Look for problems between tasks that a single task's diff wouldn't show, fix them, and re-run `board test-all <id>`.
   - Then the review skill or hook runs once, on the whole commit.
   - Then write the message with the `commit-message` skill as in step 5 (pass the ticket id, its title and the task list). If the skill isn't available, use `<id>: <ticket title>` with a body listing each task (`- T1: …`). Commit with `-F <message file>`, as in step 5. Once it goes through, run `board commit-record <id> $(git -C <wt> rev-parse HEAD)`.
3. Go through each "Done when" item. Check the ones you can actually verify (run the test, try the command) and tick them with `board done-when <id> <n>`. List the ones you couldn't verify.
4. Summarize in 3-5 lines: tasks done (with commits), the all-tests result, done-when items, anything left.
5. Say the ticket is ready for a pull request, and stop. Opening a PR isn't part of this skill.
