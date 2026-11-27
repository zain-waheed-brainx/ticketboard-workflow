---
name: merge
description: Merge one branch into another and resolve the conflicts by what each change was for. Reads both branches' change logs (docs/changes/<ref>.md, written during build) to decide, for each conflict, whether to keep one side or combine both, and asks only when the two intents contradict. Checks code that merged cleanly but changed the same function on both sides, runs the tests, and leaves the merge for you to commit. Works on any two branches, with or without a ticketboard ticket. Use for "/merge", "merge feature/x into develop", "merge these two branches", "resolve these conflicts".
argument-hint: "<source branch> [into <target branch>]"
---

# Merge

Merges **source** into **target** and resolves the conflicts using what each side's changes were for. It never commits, pushes or deletes a branch without approval.

## 1. Get ready
1. **Branches.** Take the source (and target, after "into") from the arguments. With no target, the target is the current branch. With no source either, list local branches (`git branch --sort=-committerdate`) and ask which to merge into which with AskUserQuestion. Check both exist (`git rev-parse --verify`).
2. **Where.** The merge happens where the target is checked out.
   - Find it with `git worktree list --porcelain`. If the target is checked out in a worktree, work there; if it's this checkout, work here.
   - If it isn't checked out anywhere, ask before checking it out here, and only do it when this checkout is clean.
   - That folder must be clean (`git status --porcelain`, ignoring untracked files git ignores). If it isn't, stop and say what's uncommitted. Never stash or discard someone's work.
3. **Base and overlap.** Get the merge base (`git merge-base <target> <source>`). List the files each side changed since then (`git diff --name-only <base> <side>`), and the files both changed.

## 2. Read what each side was for
1. **Change logs.** For each side, list the logs it added or changed since the base: `git diff --name-only <base> <side> -- docs/changes/`. Read each with `git show <side>:<path>`. Each entry names a file and a function, method, component or config key, with **What**, **Why** and **Keep** (what must survive any merge).
2. **No log for a side?** Fall back to its commit messages (`git log --format='%h %s%n%b' <base>..<side>`) and its diff for the overlapping files. Say so in one line: decisions on that side rest on the code, not a stated intent.
3. **Overlap summary.** Before merging, show a short list of the pieces both sides changed: file, function, and each side's Why in a few words. This is where conflicts will come from.

## 3. Merge
1. Run `git merge --no-ff --no-commit <source>` in the target's folder.
2. **No conflicts:** go to step 4 anyway. Git merging cleanly doesn't mean the result is right.
3. **For each conflicted file**, and each conflict in it:
   1. Find which function or piece of code it sits in, and that piece's entries from both sides' logs.
   2. Decide:
      - **Combine**, the usual case: both Whys still apply and both Keeps can hold. Write code that does both, keeping each side's Keep. Don't just paste both blocks one after the other.
      - **Keep target** or **Keep source**: one side's change makes the other's unnecessary (the log says it replaces or removes that code, or one side already does what the other added).
      - **Ask**: the Keeps contradict (both can't be true at once), or neither log covers this code and the right answer isn't clear from the code. Ask with AskUserQuestion: each side's What and Why in one line each, and the options Keep target, Keep source, Combine (with a one-line sketch of how).
   3. Resolve it and remove every conflict marker. Check with `git diff --check` and a search for `<<<<<<<`, `=======` and `>>>>>>>` lines.
4. **Lock and generated files** (`composer.lock`, `package-lock.json`, `yarn.lock`, build output): don't hand-merge them. Take the target's version, then add what the source added by updating only the packages the source added or changed in the manifest (e.g. `composer update vendor/package --no-install`, `npm install --package-lock-only`), and check it matches the manifest (`composer validate`). If it can't be resolved, ask.
5. **Change logs never conflict:** each branch has its own file. Keep both.

## 4. Check the result
1. **Pieces changed on both sides that merged without a conflict:** read each merged function and check both sides' Keeps still hold. Git only compares lines, so two changes can merge cleanly and still break each other (e.g. one side renames a field the other side starts using). Fix it, or ask if it's a real contradiction.
2. **Every Keep, both sides:** go through the Keep lines of each side's log entries for code the other side also touched, and confirm each still holds in the merged code.
3. **Tests.** Run the project's test command (from the ticketboard profile `board show` if this is a ticket's branch, else `CLAUDE.md`, else the obvious one for the stack). If both branches are ticketboard tickets, also run `board test-all <id>` for each. Fix failures the merge caused. Stop and ask about failures that were already on one side before the merge.
4. **Syntax:** if there's a quick lint or build step (`php -l` on the merged PHP files, `npm run build` or the type check), run it on what changed.

## 5. Hand over
1. Show a table of every decision: file, function, **Kept target / Kept source / Combined / Asked**, and one line on why.
2. Leave the merge staged. Draft the commit message with the `commit-message` skill (or a plain "Merge <source> into <target>" if it isn't available), with the decisions table as the body.
3. Ask: **Commit the merge**, **Let me review first** or **Abort the merge** (`git merge --abort`, which restores the target as it was). Commit only on a clear yes, with `git commit -F <file>` so any pre-commit hook runs. Never `--no-verify`.
4. Never push, open a PR or delete either branch unless they ask.

## Rules
- **Every side's Keep survives**, unless the user decided otherwise for that conflict.
- **No silent picks.** Each conflict's decision is in the table with its reason.
- **Don't add features or refactor while merging.** Only what the two sides need to work together.
- **Don't edit the change logs to match the merge.** They record why each branch changed things; the merge commit records how they were combined.
