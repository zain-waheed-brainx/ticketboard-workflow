---
name: resume
description: Resume work on a ticketboard ticket right here in the chat - pick the ticket, get its branch and worktree ready without touching other work, load the plan, grill-me decisions, session notes and git state, and carry on. Use for "/resume", "resume TIX-8", "pick up where I left off", "continue my ticket", "what was I doing".
argument-hint: "[ticket id]"
---

# Resume

Use the `board` CLI. The plugin's `bin/` is on PATH; if `board` isn't found, use `<this skill's base directory>/../../bin/board`. Run it from anywhere in the repo.

## 1. Pick the ticket
- Use the id from the arguments if one was given.
- Otherwise run `board which`. If it names a ticket (you're already in that ticket's worktree), use that one.
- Otherwise run `board resumable --json`:
  - empty list: say there's nothing started, and offer `/ticketboard:ticket new` or `start`.
  - one ticket: use it.
  - several: ask with AskUserQuestion. Each option is `TIX-n: title`, with the branch and last note in the description, most recently touched first, at most 4. The rest are reachable through "Other" (they can type an id).

## 2. Get the folder ready
Run `board prepare <id> --json`. It finds where the ticket's branch is checked out. It never creates a worktree, switches branches or stashes changes unless you ask.
- `"status": "ok"`: use the `worktree` it returns. It is either the ticket's existing worktree or the main checkout.
- `"status": "mismatch"`: the ticket works in the main checkout, which is now on another branch.
  - If `options` includes `switch`, ask with AskUserQuestion: **Switch the main folder to `<branch>`** or **Cancel**. On yes, run `board prepare <id> --fix switch --json`.
  - If `options` is empty, the main folder has uncommitted changes. Say so, and stop until they commit or stash them.
- `"status": "missing"`: the ticket's worktree folder was deleted, but the branch still exists. Ask: **Recreate the worktree** or **Cancel**. On yes, run `board prepare <id> --fix recreate --json`, then `board bootstrap <id>` (in the background if install may take more than about 2 minutes).
- An error saying the branch no longer exists: tell them, and offer `board start <id>` to begin a fresh branch.

## 3. Move into it
Every file edit and command for this ticket happens in the `worktree` path that `prepare` returned, never in another checkout.
- If that path is the main folder you're already in, just stay.
- If it's a worktree and you have a tool that changes this session's working directory (in the Claude desktop app, `change_directory`), move the session there.
- Otherwise say you're working in that folder, and use absolute paths and `cd "<worktree>" && …` in every command.

## 4. Load the context
Run `board show <id>`. Treat it as authoritative. It contains:
- the plan and the grill-me decisions (including which ones were Claude's calls)
- session notes (the latest one says what's next)
- commits and uncommitted changes
- the project's dev and test commands: use those, don't guess
- recent history

## 5. Continue
1. Give a 3-line summary: where it stands, what was done last, what's next.
2. Pick what comes next:
   - **Approved with tasks:** offer `/ticketboard:build <id>`, which continues from the next task (`board next <id>`).
   - **`validated` or `tasks-ready`:** offer to finish the tasks step or to approve.
   - **No plan:** offer `/ticketboard:ticket plan <id>`.
3. Carry on with what they choose.
4. At natural pauses and before you stop, save a note: `board note <id> "<done, next, gotchas>"`. The next resume starts from it.
5. Keep the column current: `board move <id> review` once it's ready for review, `done` once it's merged.
