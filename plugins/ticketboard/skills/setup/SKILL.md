---
name: setup
description: Set up ticketboard in this project after installing the plugin. Checks your tools, works out how the project installs, runs and tests (or reads the ticketboard.project.json a teammate already committed), confirms it with you, and makes new worktrees ready to run. Use for "/setup", "set up ticketboard", "prepare this repo for tickets", or when the board says the project isn't set up or its profile changed.
---

# Setup

Use the `board` CLI (the plugin's `bin/` is on PATH; if `board` isn't found, use `<this skill's base directory>/../../bin/board`). Run everything from the repo's main checkout.

## 1. Tools
Run `board doctor`. Report anything marked ✗ in one line each, with the install command for macOS (Homebrew) or a link. Stop only if `git` or `node` is missing, since the board needs both. Anything else is a warning. If it says the folder is **not a git repository**, explain that tickets use git worktrees. Ask whether to run `git init` (with a first commit) or point at the real clone, and don't continue until it is a repo.

## 2. Profile
Run `board project show`.

**A teammate already committed `ticketboard.project.json`:** summarize it in 4-6 lines (stack, dev command and port, test command, files copied into worktrees, worktree setup commands). These commands run on your machine every time work starts, so ask with AskUserQuestion: **Looks right, trust it** (Recommended), **Change something**, or **Re-detect**. On trust, run `board init` (if needed), then `board project trust`, then go to step 4.

**There's no profile yet:** run `board detect --json`, then:
1. Read the files it lists as evidence, and the README's setup section if there is one, to check or fix what it found. Look in particular at:
   - Makefile or `bin/setup` scripts that are the real setup path
   - several dev processes (e.g. Laravel + Vite)
   - services in docker-compose
   - seeding or migration steps
   - monorepo workspaces
2. Fix the detection yourself wherever the files make the answer clear. Never ask what the repo already answers.
3. If the detection lists `separateRepos`, the folder holds several git repos. Ask whether to set up ticketboard in each repo separately (Recommended) or turn the parent folder into one repo. For separate repos, run this whole skill inside each one.

## 3. Confirm
Show the proposed profile in one short message:
- stack
- base branch
- dev commands with their ports
- test, build and lint commands
- worktree: files to copy, setup commands, whether to write `.claude/launch.json`

Then ask one question at a time with AskUserQuestion, and only about what's still unsure (the `unsure` list plus anything you doubt). Give 2-4 concrete options, with the recommended one first. Typical questions:
- Which dev port?
- Run `docker compose up -d` in setup?
- Copy the real `.env`, or create it from `.env.example`?
- Which base branch?
- Should the team share these branch types and naming pattern?

Finish with: **Save this setup** (Recommended) or **Change something**.

Write the final profile to a scratchpad JSON file using this shape:
```json
{
  "version": 1,
  "name": "...",
  "stack": ["..."],
  "baseBranch": "main",
  "tools": ["git", "node", "npm"],
  "commands": {
    "dev": [{ "name": "web", "command": "npm run dev", "port": 5173 }],
    "test": "npm test",
    "build": "npm run build",
    "lint": null
  },
  "worktree": { "copyFiles": [".env"], "setup": ["npm ci"], "launch": true },
  "branch": { "types": ["feature", "hotfix", "enhancement", "bugfix", "chore"], "pattern": "{type}/{id}-{slug}" }
}
```
Include `branch` only if they want the team to share it. Personal patterns still override it locally.

Then run:
1. `board init`
2. `board project write --file <that file>` (this also trusts it)

## 4. Ready
1. Run `board doctor` again if the profile added tools.
2. Tell them to commit `ticketboard.project.json` (and the `.gitignore` change that hides `.board/`) so teammates get the same setup. Don't commit it yourself unless they ask.
3. Say what happens from now on: **Start work** creates the branch and worktree, copies the files, writes `.claude/launch.json` and runs the setup commands. Output goes to the ticket's **Setup** tab, and they can re-run it with `board bootstrap <id>`.
4. Offer to open the board (`/ticketboard:board`) or create the first ticket (`/ticketboard:ticket new`).
