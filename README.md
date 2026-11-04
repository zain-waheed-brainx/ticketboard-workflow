# Ticketboard

A Claude Code plugin that runs a ticket from idea to merged pull request:

- a local ticket board;
- grill-me planning, with the plan document beside the questions;
- a git branch and worktree for each ticket;
- test-first building, task by task;
- two reviews before every commit;
- a PR flow that works with or without GitHub CLI.

Everything about a ticket is saved, so you can plan it today and build it a month later without losing context. That covers its plan, versions, decisions, tasks, notes and history.

```
 new ticket ─► plan (grill-me) ─► tasks ─► approve ─► start (branch + worktree)
      ─► build (test → ticket review → code review → commit) ─► PR ─► review comments
      ─► merged ─► clean up ─► (QA / client change?) ─► reopen as round 2 ─► …
```

---

## Contents
- [Requirements](#requirements)
- [Install](#install)
- [Set up a project](#set-up-a-project)
- [Skills (slash commands)](#skills-slash-commands)
- [The workflow, step by step](#the-workflow-step-by-step)
- [The web board](#the-web-board)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [Working with commit hooks and review tools](#working-with-commit-hooks-and-review-tools)
- [Troubleshooting](#troubleshooting)
- [Developing the plugin](#developing-the-plugin)

---

## Requirements

| Tool | Why |
|---|---|
| **Claude Code** | Runs the skills |
| **git** (2.17+) | Branches, worktrees, `worktree remove` |
| **Node.js** (18+) | The `board` CLI and the web board. No npm packages needed |
| **GitHub CLI `gh`** (optional) | Opens PRs and reads review comments. Without it, the browser flow is used (see [PRs without gh](#prs-without-gh)) |

The project you use it in must be a git repository.

---

## Install

### From GitHub (normal use)
```bash
claude plugin marketplace add zain-waheed-brainx/ticketboard-workflow
```
```bash
claude plugin install ticketboard@ticketboard-local
```
Then start a new Claude session in your project. The commands appear as `/ticketboard:…`. If the repo is private, each teammate needs read access to it.

### From source (while developing or testing)
Load the plugin straight from a folder, for one session only. Changes take effect when that session restarts:
```bash
claude --plugin-dir "/path/to/ticketboard-workflow/plugins/ticketboard"
```

### Updating an installed copy
An installed plugin runs from a copy that Claude Code keeps. After changing the source:
1. Bump `version` in `plugins/ticketboard/.claude-plugin/plugin.json`.
2. Push.
3. Run:
   ```bash
   claude plugin marketplace update ticketboard-local
   ```
   ```bash
   claude plugin update ticketboard@ticketboard-local
   ```
4. Restart the Claude session.

---

## Set up a project

Run this once per repository, from its main checkout:

```
/ticketboard:setup
```

What it does:
1. **Checks your tools** (`board doctor`), such as git, node, and your package manager.
2. **Works out how the project runs.** It detects the stack (Node, PHP/Laravel, Python/Django, Ruby/Rails, Go, Rust, docker-compose, Makefile, monorepos) and reads the evidence files and README to find:
   - the dev command and port;
   - the test, build and lint commands;
   - which ignored files (like `.env`) each worktree needs;
   - the setup commands (like `npm ci`);
   - the base branch.
3. **Confirms with you.** It asks one question at a time, only about what it couldn't tell, including whether the team can use `gh`.
4. **Writes `ticketboard.project.json`** and trusts it on your machine.
5. **Creates `.board/`** and adds it to `.gitignore`.

**Commit `ticketboard.project.json`** so teammates get the same setup. When a teammate runs `/ticketboard:setup`, it reads the committed file, shows what it will run, and asks them to trust it.

> **Trust.** The profile contains commands that run on your machine (setup, dev, test, build, lint). They only run once you've trusted the profile. If someone changes those commands, they stop running until you review them again: run `board project trust` or `/ticketboard:setup`.

---

## Skills (slash commands)

| Command | What it does |
|---|---|
| `/ticketboard:setup` | Set up a repo: detect, confirm, write and trust `ticketboard.project.json` |
| `/ticketboard:board` | Start the web board (port 4317) and open it |
| `/ticketboard:ticket` | Everything about a ticket: `new`, `plan`, `tasks`, `start`, `reopen`, `share`, `edit`, `delete` (and `resume`, which hands over to the resume skill) |
| `/ticketboard:build <id>` | Build an approved ticket task by task in its worktree: test first, two reviews, then commit |
| `/ticketboard:pr <id>` | Open the PR, handle review comments (with your approval), and clean up after the merge |
| `/ticketboard:resume [id]` | Pick work back up in any chat: gets the worktree ready, loads all the context, and continues where you stopped |

Examples:
```
/ticketboard:ticket new Export audit log as CSV
/ticketboard:ticket plan TIX-8
/ticketboard:build TIX-8
/ticketboard:pr TIX-8
/ticketboard:resume TIX-8
/ticketboard:ticket reopen TIX-8 "QA: export times out over 10k rows"
```

---

## The workflow, step by step

### 1. Create a ticket
`/ticketboard:ticket new <title>`, or **New ticket** on the board.
- It works out the type: feature, hotfix, enhancement, bugfix or chore.
- It suggests branch names from your naming patterns.
- You choose what to do about the branch:
  - **save the branch name for later** (recommended);
  - **create the branch now** (with its worktree);
  - **use the current branch**;
  - **move your current work into a worktree**, if the main folder already has work in progress. The branch, its commits and its uncommitted files move to a new worktree, and the main folder goes back to the base branch.

### 2. Plan it
`/ticketboard:ticket plan <id>` offers three ways to plan:
- **Grill me (new plan).** Claude reads the ticket and the code, then asks one question at a time, with 2-4 concrete options and its recommendation first. Each answer is logged, and the plan document fills in live beside the questions on the board. If you answer "No preference", Claude takes the recommended option and marks it *(Claude's call)*.
- **Validate an existing plan.** Paste it or give a file. Claude lists its gaps, risks and contradictions, then grills you only on those.
- **Use an existing plan as is.**

Plan format: Goal, Scope (in and out), Decisions (each with a one-line why), Approach, Risks, Done when.

### 3. Tasks (the "how")
Once the plan is settled, Claude splits it into tasks, usually 3-10. Each task can be finished, tested and committed on its own.
- **Bigger tickets:** read-only subagents study each area of the code in parallel and work out each task's files, steps and test.
- **Every task has its own test,** with the exact command that runs only that test. Use `manual` only when an automated test is impossible.
- **Overlaps:** tasks that touch the same files run in sequence. Anything that would change *what* gets built comes back to you as a question.
- You choose three modes:

| Mode | Options |
|---|---|
| **Build** | One task at a time (cheapest), or independent tasks in parallel (subagents) |
| **Run** | Task by task (pause after each), or all in one go |
| **Commit** | One commit per task; one commit for the whole ticket; or **no commits** (you commit yourself) |

Then you **approve the plan and its tasks together**, in chat or with **Approve plan** on the board.

### 4. Start work
`/ticketboard:ticket start <id>`, or **Start work** on the board:
- creates the branch from the base branch you choose;
- creates a **worktree**, a separate folder, so your main folder is untouched;
- runs worktree setup: copies `.env`, writes `.claude/launch.json`, and runs install.

### 5. Build
`/ticketboard:build <id>`. For each task:
1. **Write the test first** and run it. It must **fail**, because the feature isn't there yet.
2. **Write the code** from the task's spec, then run the test. It must **pass**.
3. **Ticket review** (Claude, no skill): does it do everything the spec says, nothing outside the ticket's scope, and does the test really prove the spec?
4. **Code review:**
   - First Claude's own check for bugs, edge cases, error handling, debug code and lint.
   - Then the repo's review hook if it has one. Otherwise the `brainx:code-review` skill, then the `code-review` skill, then a careful read of the diff.
5. **Commit**, depending on the commit mode, with a message from the `commit-message` skill (falling back to `TIX-8 T2: <title>`). Only a commit that actually went through is recorded. The board refuses a commit that isn't on the ticket's branch, that the base branch already has, or that belongs to another task.
6. **Save a note**, then pause or continue, depending on the run mode.

At the end:
- `test-all` runs every task's test, then the project's full test command.
- A **whole-ticket review** checks the work against the plan's goal, scope, decisions and "Done when" items.
- Then the final commit, or the handover in no-commit mode.

### 6. Pull request
`/ticketboard:pr <id>`, or **Open PR** on the board. The panel shows:
- the **ready check**: tasks done, tests passed, everything committed;
- **Push branch**, which never force-pushes and asks first;
- the **title and description** to copy. The description is minimal: the title plus a few lines on what changed;
- **Open on GitHub**: the new pull request page for the branch;
- a box to paste the **PR URL**. The card then moves to **Review**.

The PR opens **ready for review**, not as a draft.

### 7. Review comments
Run `/ticketboard:pr <id>` (or `/ticketboard:resume <id>`) while the PR is open:
1. Claude reads the comments (or you paste them) and prepares a fix for each. It **changes nothing until you approve**, not even small ones.
2. Comments that would change the plan are flagged separately.
3. Approved fixes go through the same ticket review, code review and commit.
4. Replies to reviewers are posted only with your OK, or you post them yourself.

### 8. Merged → clean up
Use **Mark merged** (or `gh` detects it), then **Clean up**:
- removes the worktree, and optionally the local branch;
- moves the card to **Done**.

The ticket, plan, tasks, PR and history all stay.

### 9. QA bug or client change → reopen
`/ticketboard:ticket reopen <id> "<what they found>"`, or **Reopen** on the board. The same ticket starts a **new round**:
- a `## Round 2` section is added to the plan, and the old plan is kept as a version;
- the round's tasks are archived (`tasks-r1.json`);
- a new branch (`…-r2`) is planned from the latest base, in a new worktree, with its own PR.

Grilling only covers what's new. Earlier rounds' branches, PRs and tasks stay in the context.

### Resume at any time
`/ticketboard:resume [id]` works in any chat, including a brand-new session.
1. **Finds the ticket:** from the id, from the branch you're on, or from a list.
2. **Gets the folder ready:**
   - uses the ticket's existing worktree;
   - switches the main folder only if it's clean;
   - recreates a deleted worktree only if you agree.
3. **Moves the session there** where possible.
4. **Loads everything** (`board show`): plan, decisions, tasks, notes, commits, the project's commands, the PR state and earlier rounds.
5. **Continues:** builds the next task, handles PR comments, or offers cleanup.

---

## The web board

`/ticketboard:board`, or `board serve`, then open http://localhost:4317.

- **Columns:** backlog → planning → ready → in-progress → review → done. Drag cards between columns.
- **Cards** show the type, plan status, task progress bar, branch (or its planned name), PR badge and round.
- **Ticket view:**
  - **Plan pane:** edit, approve, version history and restore.
  - **Grill-me:** the live Q&A log.
  - **Tasks:** progress, mode pickers, test badges, "Run test", "Run all tests", the done-when checklist.
  - **Details:** description, session notes, earlier rounds.
  - **History:** every change, with who made it.
  - **Versions:** every saved plan.
  - **Context:** exactly what resume loads.
  - **Setup:** the worktree setup log.
- **Buttons:**
  - **Start work, Resume, Open PR:** start the branch, copy the resume command, open a PR.
  - **Mark merged, Clean up, Reopen:** finish a round or start the next one.
  - **Share plan, Delete:** sync the plan into the repo, or remove the ticket.
- **Branch settings:** naming patterns, types and the default pattern.

The board updates live while Claude works: it checks for changes every 1.5s.

---

## How it works

### Where data lives
- **`<main checkout>/.board/`** is gitignored. It holds tickets, plans, versions, grill-me logs, tasks, history and config.
- Every worktree finds the same `.board/` through git's common directory. So deleting a worktree never loses ticket data, and one board covers all worktrees.
- **`ticketboard.project.json`** (committed) is the team's project profile.
- **`docs/plans/<id>-<slug>.md`** (optional, committed): **Share plan** copies the plan there and keeps it in sync, so it can be reviewed in git.

```
.board/
  config.json                 personal settings (patterns, gh mode, next id)
  trusted.json                which version of the profile you trusted
  deleted.jsonl               log of deleted tickets
  tickets/TIX-8/
    ticket.json               fields, branch, worktree, PR, rounds
    plan.md                   current plan
    versions/plan-<time>.md   every earlier plan
    grill.md                  grill-me Q&A log
    tasks.json                tasks, modes, test runs, commits, done-when
    tasks-r1.json             archived tasks of earlier rounds
    history.jsonl             every action, with who did it and which session
    bootstrap.log             worktree setup output
```

### Plan statuses
`none` → `drafting` → `needs-validation` → `validated` → `tasks-ready` → `approved`

If the plan changes after its tasks were made, the tasks are marked **stale** and the plan drops back to `validated`.

### Branch naming
Patterns use the tokens `{type}` `{id}` `{ID}` `{slug}` `{user}` `{date}`. The default pattern is `{type}/{id}-{slug}`, for example `feature/tix-8-export-audit-log`.
- **Save a pattern:** `board pattern save "<pattern>"`.
- **Add a type:** `board type add release`.
- **Share with the team:** put the pattern in the profile's `branch` section.
- Personal settings override the team's.

### Worktrees
Worktrees are created at `../<repo>.worktrees/<branch>` by default. Branches are created with `--no-track`, so a branch made from `origin/main` never pushes to main by accident.

### Safety
- **Safe delete:** **Delete** checks for uncommitted files and for commits that no remote has.
  - If it finds either, you must type the ticket id to force the delete.
  - It never removes the main checkout.
  - It ignores the files setup created.
- **Commit check:** a recorded commit must exist, be on the ticket's branch, not already be on the base branch, and not belong to another task.
- **Board server:**
  - It listens on 127.0.0.1 only, and only accepts requests from its own page. Other websites, wrong host names and requests that aren't JSON are refused.
  - It has request size limits and timeouts.
  - Plan markdown is sanitized: no raw HTML and no `javascript:` links.
- **Trust:** commands from the committed profile only run after you've trusted that exact version.

---

## Configuration

### `ticketboard.project.json` (team, committed)
```json
{
  "version": 1,
  "name": "my-app",
  "stack": ["node"],
  "baseBranch": "main",
  "tools": ["git", "node", "npm"],
  "commands": {
    "dev": [{ "name": "web", "command": "npm run dev", "port": 5173 }],
    "test": "npm test",
    "build": "npm run build",
    "lint": null
  },
  "worktree": { "copyFiles": [".env"], "setup": ["npm ci"], "launch": true },
  "branch": { "types": ["feature", "hotfix", "enhancement", "bugfix", "chore"], "pattern": "{type}/{id}-{slug}" },
  "pr": { "gh": "off" }
}
```
- `branch`: optional, shares the naming pattern and branch types with the team.
- `pr.gh`: `"auto"` (default) uses `gh` when it's installed. `"off"` never uses it, for example when the org doesn't allow GitHub CLI.

### Personal settings (`.board/config.json`)
Your own overrides. The order is defaults, then the team profile, then your personal settings.
- `board pattern save "<pattern>"`: set your default branch pattern.
- `board type add <name>`: add a branch type.
- `board gh auto|off`: turn GitHub CLI on or off.

### PRs without gh
With `gh` off or not installed, the plugin never needs org approval for a new app:
- **Push:** plain `git push`, with the credentials git already has.
- **Open the PR:** in your browser, from the **Open on GitHub** link.
- **Record it:** paste the PR URL in the panel or the chat.
- **Merge:** use **Mark merged**, or tell Claude.
- **Review comments:** paste them into the chat. Claude writes the replies, and you post them.

---

## CLI reference

The skills drive a small CLI, `board`, which is on PATH inside Claude sessions through the plugin's `bin/`. You can also run it yourself from any folder in the repo. `board help` lists every command.

| Area | Commands |
|---|---|
| Setup | `init`, `doctor`, `detect`, `project [show\|write\|trust]`, `bootstrap <id>`, `config`, `serve [--port]` |
| Tickets | `new`, `list`, `show <id>`, `set <id> k=v`, `move <id> <col>`, `history <id>`, `note <id> "<text>"`, `share <id> [--off]` |
| Planning | `plan <id> [--file]`, `plan-status <id> <status>`, `grill <id> --q --a` |
| Branches | `suggest "<title>"`, `branches <id>`, `start <id> [--branch\|--current] [--base]`, `pattern save`, `type add` |
| Current work and resume | `work`, `adopt <id>`, `which`, `resumable`, `prepare <id> [--fix switch\|recreate]` |
| Tasks and tests | `tasks <id>`, `tasks-write <id>`, `task <id> <T#> status=…`, `test <id> <T#> [--before]`, `test-all <id>`, `next <id>`, `build-mode`, `run-mode`, `commit-mode <id> per-task\|single\|none`, `commit-record <id> <sha>`, `done-when <id> <n>` |
| PR and rounds | `pr-check <id>`, `pr-record <id> <url>`, `pr <id>`, `pr-state <id> open\|merged\|closed`, `gh auto\|off`, `cleanup <id> [--delete-branch]`, `reopen <id> "<reason>" [--type]` |
| Delete | `delete-check <id>`, `delete <id> [--delete-branch] [--force]` |

---

## Working with commit hooks and review tools

- **Review hooks are respected.** Build never uses `--no-verify`. If a hook blocks a commit, Claude fixes the findings and commits again, and records only the commit that went through.
- **Hooks that stage everything** (for example `git add -A` before reviewing) can commit generated files, like build output, caches or review files, along with the work. To avoid that:
  - **No-commit mode** (`commit-mode none`): Claude stages only the ticket's files by name, reviews them, and hands you a commit message plus a list of the files it left out.
  - **Gitignore** generated files, for example a review tool's working file such as `.code-reviews/brainx-review.md`.
  - The clean fix is in the hook itself: review what's staged instead of staging everything.
- **Commit messages** come from your `commit-message` skill when it's installed, so they follow the repo's own style. They're written to a file and passed with `git commit -F`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `/ticketboard:…` commands don't appear | Install the plugin, or start Claude with `--plugin-dir`, then start a **new** session |
| `board: command not found` outside Claude | Use the full path: `<repo>/plugins/ticketboard/bin/board` |
| "No board in …" | `board init` (or `/ticketboard:board`) |
| Port 4317 in use | `board serve --port 4318` |
| Worktree setup didn't run | The profile isn't trusted, or it changed: `/ticketboard:setup` or `board project trust`, then `board bootstrap <id>` |
| "Not safe to delete" | Commit and push from the worktree, or force the delete by typing the ticket id |
| PR state never changes | `gh` is off or not installed. Use **Mark merged** or `board pr-state <id> merged` |
| Task can't be marked done | Its test hasn't passed after the code: `board test <id> <T#>` |
| Recorded commit refused | The commit was blocked or made in the wrong folder. Commit in the ticket's worktree and record `git rev-parse HEAD` from there |

---

## Developing the plugin

```
.claude-plugin/marketplace.json          local marketplace (ticketboard-local)
plugins/ticketboard/
  .claude-plugin/plugin.json             name, version
  bin/board                              CLI (Node, no dependencies)
  lib/store.js                           board state, git, tasks, tests, PRs, rounds
  lib/project.js                         stack detection, profile, trust hash
  lib/server.js                          local JSON API + serves the UI
  ui/index.html                          single-page board
  skills/{board,ticket,setup,resume,build,pr}/SKILL.md
```

1. Test changes with `claude --plugin-dir plugins/ticketboard` in a demo repo, restarting the session after each change.
2. When it works, bump the version in `plugin.json`, then commit and push.
3. Teammates update with `claude plugin update ticketboard@ticketboard-local`.
