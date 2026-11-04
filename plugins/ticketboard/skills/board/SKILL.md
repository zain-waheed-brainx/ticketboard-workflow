---
name: board
description: Open the local ticketboard web board (Kanban of tickets, with each ticket's plan beside its grill-me log, history and plan versions) for this repo, setting it up first if needed. Use for "/board", "open the board", "show my tickets".
---

# Board

1. Find the CLI: `board` is on PATH via the plugin's `bin/`. If it isn't found, use `<this skill's base directory>/../../bin/board`.
2. If `board list` reports no board, run `board init`. It creates `.board/` in the main checkout and adds it to `.gitignore`.
3. Check whether the board is already running: `curl -s localhost:4317/api/rev`. If it isn't, run `board serve` with Bash `run_in_background: true`. If port 4317 is taken by another repo's board, use `--port 4318` (and so on).
4. Open `http://localhost:<port>` in the built-in browser (`preview_start` with `url`). If that isn't available, give the user the link.
5. In one line, tell them what they can do there: create and drag tickets, edit fields, edit and restore plans, start work on a branch or worktree, and share plans. Mention that `/ticketboard:ticket plan <id>` grills them and fills in the plan live.
