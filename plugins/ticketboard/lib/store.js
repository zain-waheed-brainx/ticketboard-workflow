// Ticketboard store: all board state lives in <main checkout>/.board/ (gitignored).
// Every worktree resolves the same .board/ through git's common dir, so plans,
// grill-me logs and history survive worktree deletion and months between sessions.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const project = require('./project');

const DEFAULT_CONFIG = {
  idPrefix: 'TIX',
  nextId: 1,
  columns: ['backlog', 'planning', 'ready', 'in-progress', 'review', 'done'],
  branch: {
    types: ['feature', 'hotfix', 'enhancement', 'bugfix', 'chore'],
    defaultType: 'feature',
    pattern: '{type}/{id}-{slug}',
    patterns: ['{type}/{id}-{slug}', '{type}/{slug}', '{type}/{user}/{id}-{slug}', '{id}-{slug}'],
    base: '' // empty = the branch checked out in the main checkout
  },
  worktreeDir: '../{repo}.worktrees/{branchSafe}',
  sharedPlansDir: 'docs/plans',
  // gh: 'auto' uses GitHub CLI when it's installed; 'off' never does (e.g. the org doesn't allow it),
  // so PRs are opened in the browser and their URL and state are recorded by hand.
  pr: { gh: 'auto' }
};

const PLAN_STATUSES = ['none', 'drafting', 'needs-validation', 'validated', 'tasks-ready', 'approved'];
const TASK_STATUSES = ['todo', 'doing', 'done', 'skipped'];
const BUILD_MODES = ['sequential', 'parallel'];
// one commit per task; one commit for the whole ticket at the end; or none: Claude never commits, the ticket's
// files are left staged for you to commit (for repos whose tools would commit generated junk along with the work).
const COMMIT_MODES = ['per-task', 'single', 'none'];
const RUN_MODES = ['step', 'all']; // pause after every task, or run straight through
// Per-ticket build settings in tasks.json: key -> [allowed values, default]
const TASK_SETTINGS = { buildMode: [BUILD_MODES, 'sequential'], commitMode: [COMMIT_MODES, 'per-task'], runMode: [RUN_MODES, 'step'] };

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args, cwd) {
  try { return git(args, cwd); } catch { return null; }
}

// `git status --porcelain` lines start with a status column that may be a space, so don't trim them.
function statusLines(cwd, extra = []) {
  try {
    return execFileSync('git', ['status', '--porcelain', ...extra], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n').filter(Boolean);
  } catch { return []; }
}

// A ticket worktree's changes, split into real work and the untracked files worktree setup created
// (.claude/launch.json, a copied .env). Setup files are never work to commit or lose.
function worktreeChanges(t) {
  const generated = new Set(t.generatedFiles || []);
  const work = [], setup = [];
  for (const l of statusLines(t.worktree, ['--untracked-files=all'])) {
    (l.startsWith('?? ') && generated.has(l.slice(3)) ? setup : work).push(l);
  }
  return { work, setup: setup.map(l => l.slice(3)) };
}

// A task's test: { command, description } or { manual: "<why it can't be automated>", description }.
function normTest(t) {
  if (!t) return {};
  if (typeof t === 'string') return { command: t };
  return { ...(t.command ? { command: String(t.command) } : {}), ...(t.manual ? { manual: String(t.manual) } : {}), ...(t.description ? { description: String(t.description) } : {}) };
}

// Run a shell command in cwd; keeps the last 6000 characters of output.
function runShell(command, cwd, timeoutMs = 15 * 60 * 1000) {
  return new Promise(resolve => {
    const started = Date.now();
    let output = '';
    const keep = s => { output = (output + s).slice(-6000); };
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: process.env.CI || '1', FORCE_COLOR: '0' } });
    const timer = setTimeout(() => { keep(`\n[timed out after ${Math.round(timeoutMs / 1000)}s]`); child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', d => keep(String(d)));
    child.stderr.on('data', d => keep(String(d)));
    child.on('error', e => keep(`\n${e.message}`));
    child.on('close', code => { clearTimeout(timer); resolve({ passed: code === 0, code, ms: Date.now() - started, output }); });
  });
}

function mainRoot(cwd = process.cwd()) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return path.basename(common) === '.git' ? path.dirname(common) : git(['rev-parse', '--show-toplevel'], cwd);
}

function now() { return new Date().toISOString(); }

function slugify(s, max = 40) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

function readJSON(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// pr.gh from a hand-edited profile: case-insensitive. Anything that isn't "auto" means off, because the
// safe reading of a typo in an org that forbids gh is "don't run gh".
function normPr(pr) {
  const g = String(pr.gh ?? 'auto').trim().toLowerCase();
  return { ...pr, gh: g === 'auto' ? 'auto' : 'off' };
}

function writeJSON(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`; // unique: board and CLI may write at once
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, f);
}

function readText(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}

class Board {
  constructor(cwd = process.cwd()) {
    this.root = mainRoot(cwd);
    this.dir = path.join(this.root, '.board');
    this.cwd = cwd;
  }

  get initialized() { return fs.existsSync(path.join(this.dir, 'config.json')); }

  ensure() {
    if (!this.initialized) throw new Error(`No board in ${this.root}. Run: board init`);
  }

  init() {
    fs.mkdirSync(path.join(this.dir, 'tickets'), { recursive: true });
    // Local config holds only personal overrides; team defaults come from ticketboard.project.json.
    if (!this.initialized) writeJSON(path.join(this.dir, 'config.json'), { idPrefix: DEFAULT_CONFIG.idPrefix, nextId: 1 });
    const gi = path.join(this.root, '.gitignore');
    const cur = readText(gi);
    if (!/^\/?\.board\/?$/m.test(cur)) {
      fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.board/\n');
    }
    return this.root;
  }

  // ---------- config ----------
  // defaults < team profile (committed) < personal .board/config.json
  config() {
    const local = this.localConfig();
    const p = this.profile() || {};
    const team = { ...(p.branch || {}), ...(p.baseBranch ? { base: p.baseBranch } : {}) };
    return {
      ...DEFAULT_CONFIG, ...(p.worktreeDir ? { worktreeDir: p.worktreeDir } : {}), ...local,
      branch: { ...DEFAULT_CONFIG.branch, ...team, ...(local.branch || {}) },
      pr: normPr({ ...DEFAULT_CONFIG.pr, ...(isObj(p.pr) ? p.pr : {}), ...(isObj(local.pr) ? local.pr : {}) })
    };
  }

  // Older boards saved every default locally, which would hide team settings; strip those once.
  localConfig() {
    const f = path.join(this.dir, 'config.json');
    const local = readJSON(f, {});
    if (!('columns' in local)) return local;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const slim = {};
    for (const [k, v] of Object.entries(local)) if (k !== 'branch' && (!same(v, DEFAULT_CONFIG[k]) || k === 'nextId' || k === 'idPrefix')) slim[k] = v;
    const branch = {};
    for (const [k, v] of Object.entries(local.branch || {})) if (!same(v, DEFAULT_CONFIG.branch[k])) branch[k] = v;
    if (Object.keys(branch).length) slim.branch = branch;
    return slim; // saved in slim form on the next saveConfig; reads never write
  }

  saveConfig(patch) {
    const f = path.join(this.dir, 'config.json');
    const local = this.localConfig();
    writeJSON(f, { ...local, ...patch, ...(patch.branch ? { branch: { ...(local.branch || {}), ...patch.branch } } : {}) });
    return this.config();
  }

  // ---------- project profile (ticketboard.project.json) ----------
  profile() { return project.load(this.root); }

  trusted() {
    const p = this.profile();
    return !!p && readJSON(path.join(this.dir, 'trusted.json'), {}).hash === project.commandHash(p);
  }

  trust() {
    const p = this.profile();
    if (!p) throw new Error(`No ${project.FILE} to trust`);
    writeJSON(path.join(this.dir, 'trusted.json'), { hash: project.commandHash(p), ts: now() });
  }

  saveProfile(profile) {
    const f = project.save(this.root, profile);
    if (this.initialized) this.trust(); // you just reviewed and wrote it
    return f;
  }

  savePattern(pattern, makeDefault = true) {
    const c = this.config();
    const patterns = c.branch.patterns.includes(pattern) ? c.branch.patterns : [...c.branch.patterns, pattern];
    return this.saveConfig({ branch: { patterns, ...(makeDefault ? { pattern } : {}) } });
  }

  addType(type) {
    const c = this.config();
    if (!c.branch.types.includes(type)) this.saveConfig({ branch: { types: [...c.branch.types, type] } });
  }

  // ---------- tickets ----------
  tdir(id) { return path.join(this.dir, 'tickets', id); }

  ids() {
    const d = path.join(this.dir, 'tickets');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter(n => fs.existsSync(path.join(d, n, 'ticket.json')))
      .sort((a, b) => Number(a.split('-').pop()) - Number(b.split('-').pop()));
  }

  get(id) {
    id = this.resolveId(id);
    const t = readJSON(path.join(this.tdir(id), 'ticket.json'), null);
    if (!t) throw new Error(`Unknown ticket ${id}`);
    return t;
  }

  resolveId(id) {
    if (!id) throw new Error('Ticket id required');
    const c = this.config();
    const up = String(id).toUpperCase();
    return /^\d+$/.test(up) ? `${c.idPrefix}-${up}` : up;
  }

  list() { return this.ids().map(id => this.get(id)); }

  save(t) {
    t.updated = now();
    writeJSON(path.join(this.tdir(t.id), 'ticket.json'), t);
    return t;
  }

  log(id, action, detail = {}, actor = process.env.BOARD_ACTOR || 'claude') {
    const entry = { ts: now(), actor, action, ...detail };
    const sid = process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID;
    if (sid) entry.session = sid;
    fs.appendFileSync(path.join(this.tdir(id), 'history.jsonl'), JSON.stringify(entry) + '\n');
  }

  history(id) {
    return readText(path.join(this.tdir(this.resolveId(id)), 'history.jsonl'))
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  create({ title, type, description = '', priority = 'medium', labels = [], plannedBranch = null }, actor) {
    this.ensure();
    if (!title || !String(title).trim()) throw new Error('Title is required');
    if (plannedBranch && !this.validBranch(plannedBranch)) throw new Error(`Invalid branch name: ${plannedBranch}`);
    const c = this.config();
    // Claim the id by creating its folder exclusively: the board and a CLI session can create at the same time.
    fs.mkdirSync(path.join(this.dir, 'tickets'), { recursive: true });
    let n = c.nextId, id;
    for (;; n++) {
      id = `${c.idPrefix}-${n}`;
      try { fs.mkdirSync(this.tdir(id)); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    this.saveConfig({ nextId: Math.max(n + 1, this.localConfig().nextId || 0) });
    const t = {
      id, title, type: type || c.branch.defaultType, description, priority, labels,
      column: 'backlog', planStatus: 'none', planSource: null,
      plannedBranch, branch: null, baseBranch: null, worktree: null, shared: false, sharedPath: null,
      sessions: [], created: now(), updated: now()
    };
    fs.mkdirSync(path.join(this.tdir(id), 'versions'), { recursive: true });
    this.save(t);
    fs.writeFileSync(path.join(this.tdir(id), 'plan.md'), '');
    fs.writeFileSync(path.join(this.tdir(id), 'grill.md'), `# Grill-me log: ${id} ${title}\n`);
    this.log(id, 'created', { title, type: t.type }, actor);
    return t;
  }

  update(id, patch, actor) {
    const t = this.get(id);
    const allowed = ['title', 'type', 'description', 'priority', 'labels', 'column', 'planStatus', 'baseBranch', 'plannedBranch'];
    if (patch.plannedBranch && !this.validBranch(patch.plannedBranch)) throw new Error(`Invalid branch name: ${patch.plannedBranch}`);
    if (patch.baseBranch) this.checkBase(patch.baseBranch);
    const changes = {};
    for (const k of allowed) {
      if (patch[k] === undefined || JSON.stringify(patch[k]) === JSON.stringify(t[k])) continue;
      if (k === 'column' && !this.config().columns.includes(patch[k])) throw new Error(`Unknown column ${patch[k]}`);
      if (k === 'planStatus' && !PLAN_STATUSES.includes(patch[k])) throw new Error(`Plan status must be one of ${PLAN_STATUSES.join(', ')}`);
      changes[k] = { from: t[k], to: patch[k] };
      t[k] = patch[k];
    }
    if (Object.keys(changes).length) {
      this.save(t);
      this.log(t.id, 'edited', { changes }, actor);
    }
    return t;
  }

  // What would be lost by deleting this ticket's worktree: uncommitted files and commits no remote has.
  deleteCheck(id) {
    const t = this.get(id);
    const wt = t.worktree;
    const isMain = !!wt && path.resolve(wt) === path.resolve(this.root);
    const exists = !!wt && fs.existsSync(wt);
    const r = { id: t.id, branch: t.branch, worktree: wt, worktreeExists: exists, isMain,
      dirty: [], unpushed: [], upstream: null, pushedTo: [], reasons: [] };
    // A ticket linked to the main checkout's branch removes no code, so only worktree tickets are checked.
    if (t.branch && !isMain && tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], this.root) !== null) {
      r.upstream = tryGit(['rev-parse', '--abbrev-ref', `${t.branch}@{upstream}`], this.root);
      // Commits on the branch that no remote branch (and not the base branch) has.
      const log = tryGit(['log', '--oneline', t.branch, '--not', '--remotes', ...(t.baseBranch ? [t.baseBranch] : [])], this.root) || '';
      r.unpushed = log.split('\n').filter(Boolean);
      if (r.unpushed.length) r.reasons.push(`${r.unpushed.length} commit(s) on ${t.branch} not pushed to any remote`);
      else if (r.upstream) r.pushedTo = [r.upstream];
    }
    if (exists && !isMain) {
      // Files bootstrap created (copied .env, launch.json) aren't work you'd lose.
      r.dirty = worktreeChanges(t).work;
      if (r.dirty.length) r.reasons.push(`${r.dirty.length} uncommitted or untracked file(s) in the worktree`);
    }
    r.safe = r.reasons.length === 0;
    return r;
  }

  // Removes the ticket, its worktree folder (never the main checkout) and optionally its local branch.
  // A forced delete of unsafe work also needs `confirm` set to the ticket id, so no caller can lose work by accident.
  delete(id, { force = false, confirm, deleteBranch = false, actor } = {}) {
    const t = this.get(id);
    const check = this.deleteCheck(t.id);
    if (!check.safe && !force) throw new Error(`Not safe to delete ${t.id}: ${check.reasons.join('; ')}`);
    if (!check.safe && String(confirm || '').toUpperCase() !== t.id.toUpperCase()) {
      throw new Error(`Force delete of ${t.id} needs confirm=${t.id}: ${check.reasons.join('; ')}`);
    }
    const done = [];
    if (check.worktreeExists && !check.isMain) {
      // --force: without it git refuses to remove the files setup created (.env, launch.json). When the check
      // was safe those are the only extra files; on a confirmed force delete this also discards uncommitted work.
      git(['worktree', 'remove', '--force', t.worktree], this.root);
      done.push(`removed worktree ${t.worktree}`);
    }
    tryGit(['worktree', 'prune'], this.root);
    if (deleteBranch && t.branch && !check.isMain && t.branch !== this.currentBranch(this.root)) {
      // -D: deleteCheck (or --force) already established that no commit would be lost; -d would also
      // refuse pushed branches that have no upstream configured.
      done.push(tryGit(['branch', '-D', t.branch], this.root) !== null ? `deleted local branch ${t.branch}` : `kept local branch ${t.branch} (git refused to delete it)`);
    }
    fs.rmSync(this.tdir(t.id), { recursive: true, force: true });
    done.push('deleted ticket data');
    fs.appendFileSync(path.join(this.dir, 'deleted.jsonl'), JSON.stringify({
      ts: now(), actor: actor || process.env.BOARD_ACTOR || 'claude', id: t.id, title: t.title,
      branch: t.branch, forced: force && !check.safe, reasons: check.reasons, done
    }) + '\n');
    return { id: t.id, done, sharedPath: t.shared ? t.sharedPath : null };
  }

  // ---------- plan + grill log ----------
  plan(id) { return readText(path.join(this.tdir(this.resolveId(id)), 'plan.md')); }
  grill(id) { return readText(path.join(this.tdir(this.resolveId(id)), 'grill.md')); }

  writePlan(id, content, { source, actor, note } = {}) {
    const t = this.get(id);
    const f = path.join(this.tdir(t.id), 'plan.md');
    const prev = readText(f);
    if (prev === content) return t;
    if (prev.trim()) {
      const name = `plan-${now().replace(/[:.]/g, '-')}.md`;
      fs.writeFileSync(path.join(this.tdir(t.id), 'versions', name), prev);
    }
    fs.writeFileSync(f, content);
    if (source) t.planSource = source;
    if (t.planStatus === 'none') t.planStatus = 'drafting';
    // Tasks were made from the old plan: send the plan back for a re-check and flag the tasks.
    if (['tasks-ready', 'approved'].includes(t.planStatus) && this.hasTasks(t.id)) {
      this.log(t.id, 'plan-changed-after-tasks', { was: t.planStatus }, actor);
      t.planStatus = 'validated';
      const tk = this.tasks(t.id);
      tk.stale = true;
      writeJSON(this.tasksFile(t.id), tk);
    }
    if (t.column === 'backlog') t.column = 'planning';
    this.save(t);
    this.log(t.id, 'plan-updated', { chars: content.length, ...(note ? { note } : {}) }, actor);
    if (t.shared) this.syncShared(t);
    return t;
  }

  versions(id) {
    const d = path.join(this.tdir(this.resolveId(id)), 'versions');
    return fs.existsSync(d) ? fs.readdirSync(d).sort().reverse() : [];
  }

  version(id, name) {
    if (!/^plan-[\w-]+\.md$/.test(name)) throw new Error('Bad version name');
    return readText(path.join(this.tdir(this.resolveId(id)), 'versions', name));
  }

  // ---------- tasks (the "how": checklist + per-task specs, made after grilling, before approval) ----------
  tasksFile(id) { return path.join(this.tdir(this.resolveId(id)), 'tasks.json'); }
  hasTasks(id) { return (this.tasks(id).tasks || []).length > 0; }
  tasks(id) {
    const tk = readJSON(this.tasksFile(id), { tasks: [], doneWhen: [] });
    for (const [k, [, def]] of Object.entries(TASK_SETTINGS)) if (!tk[k]) tk[k] = def;
    return tk;
  }

  // Validates ids, dependencies (must exist, no cycles), statuses; keeps progress of tasks that kept their id.
  writeTasks(id, data, { actor } = {}) {
    const t = this.get(id);
    const prev = this.tasks(t.id);
    const list = (data.tasks || []).map((x, i) => {
      const old = prev.tasks.find(p => p.id === String(x.id));
      const test = normTest(x.test);
      const sameTest = old && JSON.stringify(old.test || {}) === JSON.stringify(test);
      return {
        id: String(x.id || `T${i + 1}`), title: String(x.title || '').trim(),
        dependsOn: [...new Set((x.dependsOn || []).map(String))], files: (x.files || []).map(String),
        parallel: !!x.parallel, spec: String(x.spec || ''), claudesCall: !!x.claudesCall, test,
        status: TASK_STATUSES.includes(x.status) ? x.status : (old?.status || 'todo'),
        ...(old?.commit ? { commit: old.commit } : {}),
        ...(sameTest && old.testRuns ? { testRuns: old.testRuns } : {}) // results only stay valid for the same test
      };
    });
    if (!list.length) throw new Error('No tasks given');
    const ids = new Set();
    for (const x of list) {
      if (!x.title) throw new Error(`Task ${x.id} has no title`);
      if (!x.test.command && !x.test.manual) throw new Error(`Task ${x.id} has no test: give test.command, or test.manual with the reason it can't be automated`);
      if (ids.has(x.id)) throw new Error(`Duplicate task id ${x.id}`);
      ids.add(x.id);
    }
    for (const x of list) for (const d of x.dependsOn) if (!ids.has(d)) throw new Error(`${x.id} depends on unknown task ${d}`);
    const seen = new Set(), stack = new Set(), byId = Object.fromEntries(list.map(x => [x.id, x]));
    const visit = n => {
      if (stack.has(n)) throw new Error(`Dependency cycle through ${n}`);
      if (seen.has(n)) return;
      stack.add(n); byId[n].dependsOn.forEach(visit); stack.delete(n); seen.add(n);
    };
    list.forEach(x => visit(x.id));
    const out = {
      version: 1,
      ...Object.fromEntries(Object.entries(TASK_SETTINGS).map(([k, [allowed]]) => [k, allowed.includes(data[k]) ? data[k] : prev[k]])),
      tasks: list,
      doneWhen: (data.doneWhen || prev.doneWhen || []).map(d => typeof d === 'string' ? { text: d, checked: false } : { text: String(d.text), checked: !!d.checked }),
      created: now()
    };
    writeJSON(this.tasksFile(t.id), out);
    if (['validated', 'drafting', 'needs-validation'].includes(t.planStatus)) { t.planStatus = 'tasks-ready'; this.save(t); }
    this.log(t.id, 'tasks-written', { count: list.length, parallel: list.filter(x => x.parallel).length, buildMode: out.buildMode, commitMode: out.commitMode, runMode: out.runMode }, actor);
    return out;
  }

  updateTask(id, taskId, patch, actor) {
    const t = this.get(id);
    const tk = this.tasks(t.id);
    const x = tk.tasks.find(y => y.id === taskId);
    if (!x) throw new Error(`Unknown task ${taskId}`);
    const force = patch.force === true || patch.force === 'true';
    if (patch.status === 'done' && x.status !== 'done' && x.test?.command && !x.testRuns?.after?.passed && !force) {
      throw new Error(`${taskId}'s test hasn't passed after the code yet (${this.testState(x)}). Run: board test ${t.id} ${taskId}, or mark it done anyway with force`);
    }
    // Re-sending the commit already on the task is a no-op (it may be on base by now, after a merge).
    const sameCommit = patch.commit && x.commit && (patch.commit === x.commit || tryGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${patch.commit}^{commit}`], this.root) === x.commit);
    if (sameCommit) patch = { ...patch, commit: x.commit };
    else if (patch.commit) patch = { ...patch, commit: this.checkCommit(t, patch.commit, { tasks: tk.commitMode === 'per-task' ? tk.tasks : [], exceptTask: taskId }) };
    const changes = {};
    for (const k of ['status', 'commit', 'note', 'parallel']) {
      if (patch[k] === undefined) continue;
      if (k === 'status' && !TASK_STATUSES.includes(patch[k])) throw new Error(`Task status must be one of ${TASK_STATUSES.join(', ')}`);
      const v = k === 'parallel' ? patch[k] === true || patch[k] === 'true' : patch[k];
      if (x[k] === v) continue;
      changes[k] = { from: x[k] ?? null, to: v };
      x[k] = v;
    }
    if (!Object.keys(changes).length) return x;
    writeJSON(this.tasksFile(t.id), tk);
    this.save(t); // bumps updated, so the board refreshes and resume ordering is right
    this.log(t.id, 'task-updated', { task: taskId, changes }, actor);
    return x;
  }

  // buildMode | commitMode | runMode
  setTaskSetting(id, key, value, actor) {
    const [allowed] = TASK_SETTINGS[key] || [];
    if (!allowed) throw new Error(`Unknown setting ${key}`);
    if (!allowed.includes(value)) throw new Error(`${key.replace(/Mode$/, ' mode')} must be one of ${allowed.join(', ')}`);
    const tk = this.tasks(id);
    if (tk[key] === value) return tk;
    tk[key] = value;
    writeJSON(this.tasksFile(id), tk);
    this.log(this.resolveId(id), 'setting', { [key]: value }, actor);
    return tk;
  }

  setBuildMode(id, mode, actor) { return this.setTaskSetting(id, 'buildMode', mode, actor); }
  setCommitMode(id, mode, actor) { return this.setTaskSetting(id, 'commitMode', mode, actor); }
  setRunMode(id, mode, actor) { return this.setTaskSetting(id, 'runMode', mode, actor); }

  // ---------- task tests (test first: written and run before the code, run again after, all together at the end) ----------
  // phase 'before': run right after writing the test, before the code. Expected to FAIL; passing means the test doesn't test the new behaviour.
  // phase 'after':  run after the code. Must PASS before the task is done.
  async runTaskTest(id, taskId, phase = 'after', { actor } = {}) {
    const t = this.get(id);
    if (!['before', 'after'].includes(phase)) throw new Error('phase must be before or after');
    if (!t.worktree || !fs.existsSync(t.worktree)) throw new Error(`${t.id} has no worktree to run tests in`);
    const x = this.tasks(t.id).tasks.find(y => y.id === taskId);
    if (!x) throw new Error(`Unknown task ${taskId}`);
    if (!x.test.command) return { taskId, manual: x.test.manual, ok: null };
    const r = await runShell(x.test.command, t.worktree);
    const ok = phase === 'before' ? !r.passed : r.passed;
    const tk = this.tasks(t.id); // re-read: another run may have written meanwhile
    const y = tk.tasks.find(z => z.id === taskId);
    y.testRuns = { ...(y.testRuns || {}), [phase]: { passed: r.passed, ok, code: r.code, ms: r.ms, ts: now() } };
    if (phase === 'before') delete y.testRuns.after; // new red run: the old green result no longer counts
    y.testOutput = r.output;
    writeJSON(this.tasksFile(t.id), tk);
    this.save(this.get(t.id));
    this.log(t.id, `test-${phase}`, { task: taskId, passed: r.passed, ok }, actor);
    return { taskId, phase, ok, passed: r.passed, code: r.code, ms: r.ms, output: r.output, command: x.test.command };
  }

  // End of build: every task's test (in task order), then the project's own test command.
  async runAllTests(id, { actor } = {}) {
    const t = this.get(id);
    if (!t.worktree || !fs.existsSync(t.worktree)) throw new Error(`${t.id} has no worktree to run tests in`);
    const results = [];
    for (const x of this.tasks(t.id).tasks) {
      if (x.status === 'skipped') { results.push({ taskId: x.id, skipped: true }); continue; }
      if (!x.test.command) { results.push({ taskId: x.id, manual: x.test.manual }); continue; }
      const r = await runShell(x.test.command, t.worktree);
      results.push({ taskId: x.id, passed: r.passed, code: r.code, ms: r.ms, output: r.passed ? '' : r.output });
    }
    const projectCmd = this.profile()?.commands?.test;
    const projectFile = require('./project').FILE;
    let project = null;
    if (projectCmd && !this.trusted()) {
      project = { command: projectCmd, passed: false, skipped: `not run: ${projectFile} changed since you last reviewed it; run board project trust (or /ticketboard:setup)` };
    } else if (projectCmd) {
      const r = await runShell(projectCmd, t.worktree);
      project = { command: projectCmd, passed: r.passed, code: r.code, ms: r.ms, output: r.passed ? '' : r.output };
    }
    const ok = results.every(r => r.passed !== false) && (!project || project.passed);
    const tk = this.tasks(t.id);
    tk.finalRun = { ok, ts: now(), results: results.map(({ output, ...r }) => r), project: project && (({ output, ...p }) => p)(project) };
    writeJSON(this.tasksFile(t.id), tk);
    this.save(this.get(t.id));
    this.log(t.id, 'test-all', { ok, failed: results.filter(r => r.passed === false).map(r => r.taskId), project: project ? project.passed : null }, actor);
    return { ok, results, project };
  }

  // Human-readable state of a task's test.
  testState(x) {
    const r = x.testRuns || {};
    if (!x.test?.command) return x.test?.manual ? 'manual' : 'none';
    if (r.after) return r.after.passed ? 'passing' : 'failing';
    if (r.before) return r.before.passed ? 'passes-before-code' : 'red';
    return 'not-run';
  }

  // A recorded commit must really be this ticket's work: an existing commit on the ticket's branch that the
  // base branch doesn't have, and not one already recorded for another task. Catches recording a stale HEAD
  // (the previous task's commit, or the wrong checkout's) after a hook such as a review blocked the commit.
  checkCommit(t, sha, { tasks = [], exceptTask } = {}) {
    const s = String(sha || '').trim();
    const full = !s.startsWith('-') && tryGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${s}^{commit}`], this.root);
    if (!full) throw new Error(`Commit ${s} doesn't exist. Did the commit go through? A commit hook (e.g. a review) may have blocked it`);
    if (!t.branch) throw new Error(`${t.id} has no branch yet, so no commit can be recorded`);
    if (!this.branchExists(t.branch)) throw new Error(`${t.id}'s branch ${t.branch} doesn't exist locally, so the commit can't be checked`);
    // merge-base --is-ancestor exits 0 (yes) or 1 (no); both refs are known to resolve here, so null means "no".
    if (tryGit(['merge-base', '--is-ancestor', full, `refs/heads/${t.branch}`], this.root) === null) {
      throw new Error(`Commit ${full.slice(0, 7)} isn't on ${t.id}'s branch ${t.branch}. Commit from the ticket's worktree (${t.worktree}) and record that commit`);
    }
    // A base that no longer resolves (e.g. a deleted remote branch) can't be compared, so that check is skipped.
    const base = t.baseBranch && tryGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${t.baseBranch}^{commit}`], this.root);
    if (base && tryGit(['merge-base', '--is-ancestor', full, base], this.root) !== null) {
      throw new Error(`Commit ${full.slice(0, 7)} is already on the base branch ${t.baseBranch}, so it isn't this ticket's work. Did the commit go through?`);
    }
    // Per-task commits are one per task (in single and none modes the tasks share one commit, so no list is passed).
    const resolve = c => tryGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${c}^{commit}`], this.root);
    const other = tasks.find(o => o.id !== exceptTask && o.commit && (o.commit === full || resolve(o.commit) === full));
    if (other) throw new Error(`Commit ${full.slice(0, 7)} is already recorded for ${other.id}. Did this commit go through? A commit hook (e.g. a review) may have blocked it`);
    return full;
  }

  // Single-commit mode: record the one commit on every finished task that doesn't have one yet.
  recordCommit(id, sha, actor) {
    const tk = this.tasks(id);
    sha = this.checkCommit(this.get(id), sha, { tasks: tk.tasks });
    const marked = tk.tasks.filter(x => x.status === 'done' && !x.commit);
    marked.forEach(x => { x.commit = sha; });
    writeJSON(this.tasksFile(id), tk);
    this.save(this.get(id));
    this.log(this.resolveId(id), 'commit-recorded', { commit: sha, tasks: marked.map(x => x.id) }, actor);
    return marked.map(x => x.id);
  }

  checkDoneWhen(id, index, checked = true, actor) {
    const tk = this.tasks(id);
    const d = tk.doneWhen[index];
    if (!d) throw new Error(`No done-when item #${index + 1}`);
    d.checked = !!checked;
    writeJSON(this.tasksFile(id), tk);
    this.log(this.resolveId(id), 'done-when', { item: index + 1, checked: d.checked }, actor);
    return tk;
  }

  // What build should do next. Sequential: the first ready task. Parallel: every ready task marked
  // parallel whose files don't overlap another one in the batch (a task not marked parallel runs alone).
  nextTasks(id) {
    const tk = this.tasks(id);
    const done = new Set(tk.tasks.filter(x => ['done', 'skipped'].includes(x.status)).map(x => x.id));
    const ready = tk.tasks.filter(x => !done.has(x.id) && x.dependsOn.every(d => done.has(d)));
    const doing = tk.tasks.filter(x => x.status === 'doing');
    const overlap = (a, b) => a.files.some(f => b.files.some(g => f === g || f.startsWith(g.replace(/\*.*$/, '')) || g.startsWith(f.replace(/\*.*$/, ''))));
    let batch = [];
    if (doing.length) batch = doing; // finish what was started first
    else if (ready.length) {
      if (tk.buildMode === 'parallel') {
        for (const x of ready.filter(y => y.parallel)) if (!batch.some(b => overlap(b, x))) batch.push(x);
        if (batch.length < 2) batch = [ready[0]];
      } else batch = [ready[0]];
    }
    return {
      mode: tk.buildMode, commitMode: tk.commitMode, runMode: tk.runMode, stale: !!tk.stale, total: tk.tasks.length, done: done.size,
      uncommitted: tk.tasks.filter(x => x.status === 'done' && !x.commit).map(x => x.id),
      batch: batch.map(x => ({ id: x.id, title: x.title, files: x.files, spec: x.spec, status: x.status, test: x.test, testState: this.testState(x) })),
      finalRun: tk.finalRun ? { ok: tk.finalRun.ok, ts: tk.finalRun.ts } : null,
      allDone: tk.tasks.length > 0 && done.size === tk.tasks.length,
      doneWhen: tk.doneWhen
    };
  }

  grillAdd(id, q, a, actor) {
    const t = this.get(id);
    const n = (this.grill(t.id).match(/^## Q\d+/gm) || []).length + 1;
    fs.appendFileSync(path.join(this.tdir(t.id), 'grill.md'), `\n## Q${n}: ${q}\n**Answer:** ${a}\n`);
    if (t.planStatus === 'none') { t.planStatus = 'drafting'; }
    if (t.column === 'backlog') t.column = 'planning';
    this.save(t);
    this.log(t.id, 'grill-answer', { q: n }, actor);
    return n;
  }

  // ---------- sharing ----------
  sharedFile(t) {
    return path.join(this.root, this.config().sharedPlansDir, `${t.id}-${slugify(t.title)}.md`);
  }

  syncShared(t) {
    const f = this.sharedFile(t);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const header = `<!-- Shared from ticketboard ${t.id}. Edit on the board; this file is overwritten. -->\n`;
    const plan = this.plan(t.id);
    // Only add a title when the plan doesn't already open with one, so the doc keeps a single H1.
    const title = /^\s*# /.test(plan) ? '' : `# ${t.id}: ${t.title}\n\n`;
    fs.writeFileSync(f, header + title + plan);
    return f;
  }

  share(id, on = true, actor) {
    const t = this.get(id);
    if (on) {
      t.shared = true;
      t.sharedPath = path.relative(this.root, this.syncShared(t));
    } else {
      t.shared = false;
    }
    this.save(t);
    this.log(t.id, on ? 'plan-shared' : 'plan-unshared', { path: t.sharedPath }, actor);
    return t;
  }

  // ---------- branches + worktrees ----------
  currentBranch(cwd = this.root) { return tryGit(['branch', '--show-current'], cwd) || null; }

  branchName(t, { type, pattern } = {}) {
    const c = this.config();
    const user = slugify((tryGit(['config', 'user.name'], this.root) || 'me').split(' ')[0], 20);
    const vals = { type: type || t.type, id: t.id.toLowerCase(), ID: t.id, slug: slugify(t.title), user, date: now().slice(0, 10) };
    return (pattern || c.branch.pattern).replace(/\{(\w+)\}/g, (m, k) => vals[k] ?? m);
  }

  branchOptions(id, type, pattern) { return this.branchOptionsFor(this.get(id), type, pattern); }

  // Suggestions for a ticket that doesn't exist yet (the New ticket popup): uses the next id.
  branchOptionsDraft({ title = '', type } = {}, pattern) {
    const c = this.config();
    return this.branchOptionsFor({ id: `${c.idPrefix}-${c.nextId}`, title: title || 'untitled', type: type || c.branch.defaultType }, type, pattern);
  }

  branchOptionsFor(t, type, pattern) {
    const c = this.config();
    const seen = new Set();
    const options = [];
    const add = (name, p, extra = {}) => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      options.push({ pattern: p, name, isDefault: p === c.branch.pattern, valid: this.validBranch(name), exists: this.branchExists(name), ...extra });
    };
    if (t.plannedBranch) add(t.plannedBranch, null, { planned: true });
    for (const p of [c.branch.pattern, ...c.branch.patterns]) add(this.branchName(t, { type, pattern: p }), p);
    const o = { current: this.currentBranch(), types: c.branch.types, options };
    if (pattern) {
      o.preview = pattern.includes('{') ? this.branchName(t, { type, pattern }) : pattern;
      o.previewValid = this.validBranch(o.preview);
      o.previewExists = this.branchExists(o.preview);
    }
    return o;
  }

  // For the base-branch dropdown: local and remote-tracking branches, plus which one is the default base.
  gitBranches() {
    const refs = prefix => (tryGit(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', prefix], this.root) || '')
      .split('\n').filter(Boolean);
    const local = refs('refs/heads');
    const remote = refs('refs/remotes').filter(r => !r.endsWith('/HEAD') && r.includes('/'));
    const c = this.config();
    const current = this.currentBranch(this.root);
    const def = c.branch.base || current || local[0] || 'HEAD';
    return { local, remote, current, default: def };
  }

  branchExists(name) { return tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], this.root) !== null; }

  validBranch(name) { return !String(name).startsWith('-') && tryGit(['check-ref-format', '--branch', name], this.root) !== null; }

  // A base must be an existing commit-ish and must never be read by git as an option.
  checkBase(base) {
    if (!base || String(base).startsWith('-') || tryGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`], this.root) === null) {
      throw new Error(`Unknown base branch: ${base}`);
    }
    return base;
  }

  // Base when none is configured: origin's default branch, else main/master/develop, else main.
  detectBase() {
    const c = this.config().branch.base;
    if (c) return c;
    const head = tryGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], this.root);
    if (head) return head.replace(/^origin\//, '');
    return ['main', 'master', 'develop'].find(b => this.branchExists(b)) || 'main';
  }

  start(id, { branch, useCurrent = false, worktree = true, base, actor } = {}) {
    const t = this.get(id);
    const c = this.config();
    if (useCurrent) {
      branch = this.currentBranch(this.cwd);
      if (!branch) throw new Error('Detached HEAD: no current branch to use');
      t.branch = branch;
      t.worktree = tryGit(['rev-parse', '--show-toplevel'], this.cwd);
    } else {
      branch = branch || t.plannedBranch || this.branchName(t);
      if (!this.validBranch(branch)) throw new Error(`Invalid branch name: ${branch}`);
      base = base || c.branch.base || this.currentBranch(this.root) || 'HEAD';
      const exists = this.branchExists(branch);
      if (!exists) this.checkBase(base);
      if (worktree) {
        const wt = this.worktreePath(t, branch);
        if (fs.existsSync(wt)) throw new Error(`Worktree path already exists: ${wt}`);
        // --no-track: a branch made from a remote base must not inherit that branch as its upstream.
        git(exists ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '--no-track', '-b', branch, wt, base], this.root);
        t.worktree = wt;
      } else {
        git(exists ? ['switch', branch] : ['switch', '--no-track', '-c', branch, base], this.root);
        t.worktree = this.root;
      }
      t.baseBranch = base;
      t.branch = branch;
    }
    if (['backlog', 'planning', 'ready'].includes(t.column)) t.column = 'in-progress';
    this.save(t);
    this.log(t.id, 'work-started', { branch: t.branch, worktree: t.worktree, useCurrent }, actor);
    return t;
  }

  // Prepare a new worktree from the project profile: copy ignored files, write .claude/launch.json,
  // run setup commands. Output goes to the ticket's bootstrap.log (and onOutput, for the CLI).
  async bootstrap(id, { onOutput, actor } = {}) {
    const t = this.get(id);
    const p = this.profile();
    const wt = t.worktree;
    if (!p) return { skipped: `no ${project.FILE} (run /ticketboard:setup)` };
    if (!wt || path.resolve(wt) === path.resolve(this.root)) return { skipped: 'ticket uses the main checkout' };
    if (!this.trusted()) return { skipped: `${project.FILE} changed since you last reviewed it; run board project trust (or /ticketboard:setup)` };
    const logFile = path.join(this.tdir(t.id), 'bootstrap.log');
    const write = s => { fs.appendFileSync(logFile, s); if (onOutput) onOutput(s); };
    fs.writeFileSync(logFile, `# bootstrap ${t.id} ${now()}\n`);
    const generated = [];
    const setStatus = (status, extra = {}) => {
      const cur = this.get(t.id);
      cur.bootstrap = { status, ts: now(), ...extra };
      if (generated.length) cur.generatedFiles = [...new Set([...(cur.generatedFiles || []), ...generated])];
      this.save(cur);
    };
    setStatus('running');
    for (const f of p.worktree?.copyFiles || []) {
      const src = path.join(this.root, f), dest = path.join(wt, f);
      if (!fs.existsSync(src)) { write(`skip copy ${f} (not in main checkout)\n`); continue; }
      if (fs.existsSync(dest)) { write(`keep ${f} (already in worktree)\n`); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      generated.push(f);
      write(`copied ${f}\n`);
    }
    const dev = p.commands?.dev || [];
    if (p.worktree?.launch !== false && dev.length && !fs.existsSync(path.join(wt, '.claude', 'launch.json'))) {
      const configurations = dev.map(d => {
        const simple = !/[|&;<>()$`"'*?]/.test(d.command);
        const parts = d.command.trim().split(/\s+/);
        return { name: d.name, runtimeExecutable: simple ? parts[0] : 'sh', runtimeArgs: simple ? parts.slice(1) : ['-c', d.command], ...(d.port ? { port: d.port } : {}) };
      });
      writeJSON(path.join(wt, '.claude', 'launch.json'), { version: '0.0.1', configurations });
      generated.push('.claude/launch.json');
      write('wrote .claude/launch.json\n');
    }
    for (const cmd of p.worktree?.setup || []) {
      write(`\n$ ${cmd}\n`);
      const code = await new Promise(resolve => {
        const child = spawn(cmd, { cwd: wt, shell: true, env: { ...process.env, CI: process.env.CI || '1' } });
        child.stdout.on('data', d => write(String(d)));
        child.stderr.on('data', d => write(String(d)));
        child.on('close', resolve);
        child.on('error', e => { write(`${e.message}\n`); resolve(127); });
      });
      if (code !== 0) {
        setStatus('failed', { command: cmd, code });
        this.log(t.id, 'bootstrap-failed', { command: cmd, code }, actor);
        return { failed: cmd, code, log: logFile };
      }
    }
    setStatus('done');
    this.log(t.id, 'bootstrap-done', { steps: (p.worktree?.setup || []).length, copied: generated.length }, actor);
    return { done: true, log: logFile };
  }

  bootstrapLog(id) { return readText(path.join(this.tdir(this.resolveId(id)), 'bootstrap.log')); }

  worktreePath(t, branch) {
    return path.resolve(this.root, this.config().worktreeDir
      .replace('{repo}', path.basename(this.root)).replace('{branchSafe}', branch.replace(/[\/\\]/g, '-')).replace('{id}', t.id));
  }

  // [{ path, branch }] for every worktree git knows about (main checkout included).
  worktrees() {
    tryGit(['worktree', 'prune'], this.root); // forget folders deleted by hand
    const out = [];
    let cur = null;
    for (const line of (tryGit(['worktree', 'list', '--porcelain'], this.root) || '').split('\n')) {
      if (line.startsWith('worktree ')) out.push(cur = { path: line.slice(9), branch: null });
      else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
    return out;
  }

  // Find where to work on the ticket without touching other work. Only an existing worktree is used:
  //  - branch checked out somewhere -> { status: 'ok', worktree }
  //  - ticket works in the main checkout, which is on another branch -> { status: 'mismatch', options: ['switch'] (only if clean) }
  //  - ticket's worktree folder is gone -> { status: 'missing', options: ['recreate'] }
  prepare(id, { fix, actor } = {}) {
    const t = this.get(id);
    if (!t.branch) {
      throw new Error(`${t.id} hasn't been started${t.plannedBranch ? ` (planned branch ${t.plannedBranch})` : ''}. Start it first: board start ${t.id}`);
    }
    const isMain = p => !!p && path.resolve(p) === path.resolve(this.root);
    const here = this.worktrees().find(w => w.branch === t.branch);
    if (here) {
      if (path.resolve(here.path) !== path.resolve(t.worktree || '')) {
        this.log(t.id, 'relinked', { from: t.worktree, to: here.path }, actor);
        t.worktree = here.path;
        this.save(t);
      }
      return { status: 'ok', id: t.id, branch: t.branch, worktree: here.path, action: isMain(here.path) ? 'main-checkout' : 'existing' };
    }
    // The branch isn't checked out anywhere.
    const local = this.branchExists(t.branch);
    const remote = !local && tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${t.branch}`], this.root) !== null;
    if (!local && !remote) throw new Error(`Branch ${t.branch} no longer exists locally or on origin. Start the ticket again: board start ${t.id}`);
    const dirty = statusLines(this.root);
    if (!t.worktree || isMain(t.worktree)) {
      // Ticket works in the main checkout: stay there; switching is offered only when nothing is uncommitted.
      if (fix !== 'switch') {
        return {
          status: 'mismatch', id: t.id, branch: t.branch, current: this.currentBranch(this.root), mainDirty: dirty.length,
          options: dirty.length ? [] : ['switch']
        };
      }
      if (dirty.length) throw new Error(`Main checkout has ${dirty.length} uncommitted change(s); commit or stash them first`);
      git(['switch', t.branch], this.root);
      t.worktree = this.root;
      this.save(t);
      this.log(t.id, 'resume-switched', { branch: t.branch }, actor);
      return { status: 'ok', id: t.id, branch: t.branch, worktree: this.root, action: 'switched' };
    }
    // The ticket had its own worktree, but the folder is gone: recreate only when asked.
    if (fix !== 'recreate') return { status: 'missing', id: t.id, branch: t.branch, worktree: t.worktree, options: ['recreate'] };
    const wt = this.worktreePath(t, t.branch);
    if (fs.existsSync(wt)) throw new Error(`Can't create worktree: ${wt} exists but isn't a worktree for ${t.branch}. Move it away and retry.`);
    git(['worktree', 'add', wt, t.branch], this.root); // from origin/<branch> if only the remote has it
    this.log(t.id, 'worktree-created-on-resume', { from: t.worktree, to: wt, fromRemote: remote }, actor);
    t.worktree = wt;
    this.save(t);
    return { status: 'ok', id: t.id, branch: t.branch, worktree: wt, action: 'created', needsSetup: true };
  }

  // What's in progress in the main checkout right now (for "move my current work into a worktree").
  currentWork() {
    const branch = this.currentBranch(this.root);
    const base = this.detectBase();
    const isBase = !branch || branch === base;
    const dirtyFiles = statusLines(this.root, ['--untracked-files=all']).filter(l => l.slice(3) !== project.FILE);
    const ahead = !isBase && this.branchExists(base)
      ? (tryGit(['log', '--oneline', `${base}..${branch}`], this.root) || '').split('\n').filter(Boolean) : [];
    const owner = branch ? this.list().find(t => t.branch === branch && path.resolve(t.worktree || '') !== path.resolve(this.root)) : null;
    return {
      branch, base, isBase, detached: !branch, commits: ahead, dirtyFiles, owner: owner ? owner.id : null,
      hasWork: !isBase || dirtyFiles.length > 0
    };
  }

  // Move the main checkout's current work into the ticket's worktree and put the main checkout back on
  // the base branch. On a feature branch the branch itself moves; on the base branch (or detached) a new
  // branch is made from the current commit. Uncommitted and untracked changes travel via a tagged stash
  // that is dropped only after it applies cleanly; on any failure the changes are put back or the stash is kept.
  adopt(id, { branch: newBranch, actor } = {}) {
    const t = this.get(id);
    const w = this.currentWork();
    // A ticket already linked to the main checkout's current branch can move into a worktree too.
    const linkedHere = t.branch && t.branch === w.branch && path.resolve(t.worktree || '') === path.resolve(this.root);
    if (t.branch && !linkedHere) throw new Error(`${t.id} is already started on ${t.branch}`);
    if (!w.hasWork) throw new Error('Nothing to move: the main checkout is on the base branch with no changes');
    if (w.owner) throw new Error(`${w.branch} already belongs to ${w.owner}`);
    const moveBranch = !w.isBase;
    const branch = moveBranch ? w.branch : (newBranch || t.plannedBranch || this.branchName(t));
    if (!moveBranch && !this.validBranch(branch)) throw new Error(`Invalid branch name: ${branch}`);
    if (!moveBranch && this.branchExists(branch)) throw new Error(`Branch ${branch} already exists`);
    const wt = this.worktreePath(t, branch);
    if (fs.existsSync(wt)) throw new Error(`Worktree path already exists: ${wt}`);

    let stash = null;
    const tag = `ticketboard-adopt-${t.id}-${Date.now()}`;
    if (w.dirtyFiles.length) {
      git(['stash', 'push', '--include-untracked', '-m', tag, '--', '.', `:(exclude)${project.FILE}`], this.root);
      const entry = (tryGit(['stash', 'list', '--format=%H %gs'], this.root) || '').split('\n').find(l => l.endsWith(tag));
      if (!entry) throw new Error('Could not save your changes to a stash; nothing was moved');
      stash = entry.split(' ')[0];
    }
    const putBack = () => { if (stash) tryGit(['stash', 'apply', '--index', stash], this.root) !== null && this.dropStash(stash); };
    try {
      if (moveBranch) {
        git(['switch', w.base], this.root);
        git(['worktree', 'add', wt, branch], this.root);
      } else {
        git(['worktree', 'add', '--no-track', '-b', branch, wt, 'HEAD'], this.root);
      }
    } catch (e) {
      if (moveBranch && this.currentBranch(this.root) !== w.branch) tryGit(['switch', w.branch], this.root);
      putBack();
      throw new Error(`Nothing was moved (your changes are back where they were): ${e.stderr ? String(e.stderr).trim() : e.message}`);
    }
    let changes = 'none';
    if (stash) {
      if (tryGit(['stash', 'apply', '--index', stash], wt) !== null || tryGit(['stash', 'apply', stash], wt) !== null) {
        this.dropStash(stash);
        changes = 'moved';
      } else {
        changes = `kept in stash ${stash.slice(0, 10)} ("${tag}"): run git stash apply ${stash.slice(0, 10)} in the worktree`;
      }
    }
    t.branch = branch;
    t.worktree = wt;
    t.baseBranch = w.base;
    if (['backlog', 'planning', 'ready'].includes(t.column)) t.column = 'in-progress';
    this.save(t);
    this.log(t.id, 'adopted', { branch, worktree: wt, commits: w.commits.length, files: w.dirtyFiles.length, changes, movedBranch: moveBranch }, actor);
    return { ticket: t, branch, worktree: wt, movedBranch: moveBranch, commits: w.commits.length, files: w.dirtyFiles.length, changes, mainNowOn: this.currentBranch(this.root) };
  }

  dropStash(sha) {
    const list = (tryGit(['stash', 'list', '--format=%H'], this.root) || '').split('\n');
    const n = list.indexOf(sha);
    if (n >= 0) tryGit(['stash', 'drop', `stash@{${n}}`], this.root);
  }

  // Tickets worth resuming: started, not done; most recently touched first.
  resumable() {
    return this.list().filter(t => t.branch && t.column !== 'done').sort((a, b) => b.updated.localeCompare(a.updated));
  }

  // Ticket for the branch checked out at cwd (used by "resume" inside a worktree).
  which(cwd = this.cwd) {
    const b = this.currentBranch(cwd);
    return this.list().find(t => t.branch && t.branch === b) || null;
  }

  addSession(id, note, actor) {
    const t = this.get(id);
    const sid = process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null;
    t.sessions.push({ ts: now(), session: sid, note });
    this.save(t);
    this.log(t.id, 'session-note', { note }, actor);
    return t;
  }

  // Everything a fresh Claude session needs to pick the ticket back up.
  context(id) {
    const t = this.get(id);
    const hist = this.history(t.id).slice(-25);
    let gitInfo = '';
    if (t.branch && t.worktree && fs.existsSync(t.worktree)) {
      const base = t.baseBranch || 'HEAD';
      const log = tryGit(['log', '--oneline', `${base}..${t.branch}`], t.worktree) || '(no commits yet)';
      const ch = worktreeChanges(t);
      const status = ch.work.join('\n') || '(clean)';
      const setup = ch.setup.length ? `\nSetup files (created by worktree setup, not work to commit): ${ch.setup.join(', ')}` : '';
      gitInfo = `\n## Git (${t.branch} vs ${base})\nCommits:\n${log}\n\nWorking tree:\n${status}${setup}\n`;
    } else if (t.worktree) {
      gitInfo = `\n## Git\nWorktree ${t.worktree} no longer exists. Branch: ${t.branch}\n`;
    }
    const sessions = t.sessions.slice(-10).map(s => `- ${s.ts.slice(0, 16)} ${s.note}`).join('\n');
    const p = this.profile();
    const projectInfo = p ? [`\n## Project (${project.FILE})`,
      ...(p.commands?.dev || []).map(d => `dev: ${d.command}${d.port ? ` (port ${d.port})` : ''}`),
      p.commands?.test ? `test: ${p.commands.test}` : '', p.commands?.build ? `build: ${p.commands.build}` : '',
      t.bootstrap ? `worktree setup: ${t.bootstrap.status}${t.bootstrap.command ? ` at "${t.bootstrap.command}"` : ''}` : ''
    ].filter(Boolean).join('\n') : '';
    return [
      `# ${t.id}: ${t.title}`,
      `type=${t.type} column=${t.column} priority=${t.priority} plan=${t.planStatus}${t.planSource ? ` (${t.planSource})` : ''}`,
      `branch=${t.branch || (t.plannedBranch ? `${t.plannedBranch} (planned, not created)` : '-')} worktree=${t.worktree || '-'}${t.shared ? ` shared=${t.sharedPath}` : ''}`,
      t.round > 1 ? `round=${t.round} (reopened: ${t.reopenReason})` : '',
      t.pr ? `pr=#${t.pr.number} ${t.pr.state}${t.pr.url ? ` ${t.pr.url}` : ''}` : '',
      t.description ? `\n## Description\n${t.description}` : '',
      `\n## Plan\n${this.plan(t.id).trim() || '(no plan yet)'}`,
      this.tasksSummary(t.id),
      this.roundsSummary(t.id),
      `\n## Grill-me decisions\n${this.grill(t.id).replace(/^# .*\n/, '').trim() || '(none)'}`,
      sessions ? `\n## Session notes\n${sessions}` : '',
      gitInfo,
      projectInfo,
      `\n## Recent history\n${hist.map(h => `- ${h.ts.slice(0, 16)} ${h.actor} ${h.action}`).join('\n')}`
    ].filter(Boolean).join('\n');
  }

  tasksSummary(id) {
    const tk = this.tasks(id);
    if (!tk.tasks.length) return '\n## Tasks\n(none yet: run the tasks step)';
    const mark = { todo: '[ ]', doing: '[~]', done: '[x]', skipped: '[-]' };
    const n = this.nextTasks(id);
    return [`\n## Tasks (${n.done}/${n.total} done, build mode: ${tk.buildMode}, commits: ${{ single: 'one for the whole ticket at the end', none: 'none, you commit the staged changes yourself' }[tk.commitMode] || 'one per task'}, run: ${tk.runMode === 'all' ? 'all in one go' : 'task by task'}${tk.stale ? ', STALE: plan changed after these were made' : ''})`,
      tk.commitMode !== 'per-task' && n.uncommitted.length ? `Done but not committed yet: ${n.uncommitted.join(', ')} (changes are in the worktree${tk.commitMode === 'none' ? '; you commit them yourself' : ''})` : '',
      ...tk.tasks.map(x => `${mark[x.status]} ${x.id} ${x.title}${x.dependsOn.length ? ` (after ${x.dependsOn.join(', ')})` : ''}${x.parallel ? ' [parallel]' : ''}${x.commit ? ` @${x.commit.slice(0, 7)}` : ''} | test: ${this.testState(x)}${x.test?.command ? ` (${x.test.command})` : x.test?.manual ? ` (manual: ${x.test.manual})` : ''}`),
      n.batch.length ? `Next: ${n.batch.map(x => x.id).join(' + ')}` : n.allDone ? 'All tasks done.' : '',
      tk.finalRun ? `All tests together: ${tk.finalRun.ok ? 'PASSED' : 'FAILED'} (${tk.finalRun.ts.slice(0, 16)})` : n.allDone ? 'All tests together: not run yet' : '',
      tk.doneWhen.length ? `Done when:\n${tk.doneWhen.map(d => `${d.checked ? '[x]' : '[ ]'} ${d.text}`).join('\n')}` : ''
    ].filter(Boolean).join('\n');
  }

  // ---------- pull requests + rounds ----------
  // gh is optional. Returns undefined when gh isn't installed; throws on a gh error.
  gh(args, cwd = this.root) {
    if (this.config().pr.gh === 'off') return undefined;
    try {
      // Timeout: the board server is single-threaded, so a hung network call or auth prompt must not freeze it.
      return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 10 * 1024 * 1024 }).trim();
    } catch (e) {
      if (e.code === 'ENOENT') return undefined;
      if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') throw Object.assign(new Error('gh timed out after 15s'), { stderr: 'gh timed out after 15s' });
      throw e;
    }
  }

  hasGh() { return this.gh(['--version']) !== undefined; }

  setGhMode(mode) {
    if (!['auto', 'off'].includes(mode)) throw new Error('gh mode must be auto (use it when installed) or off (never use it)');
    const cur = this.localConfig().pr;
    return this.saveConfig({ pr: { ...(isObj(cur) ? cur : {}), gh: mode } }).pr;
  }

  // Is the ticket ready for a PR? Also gives a minimal draft title/body for the pr skill to refine.
  prCheck(id) {
    const t = this.get(id);
    const reasons = [];
    const wt = t.worktree;
    if (!t.branch) reasons.push(`${t.id} has no branch yet`);
    if (!wt || !fs.existsSync(wt)) reasons.push(`${t.id} has no worktree`);
    if (this.hasTasks(t.id)) {
      const n = this.nextTasks(t.id);
      const tk = this.tasks(t.id);
      if (!n.allDone) reasons.push(`${n.total - n.done} task(s) not done`);
      if (n.uncommitted.length) reasons.push(tk.commitMode === 'none'
        ? `commit mode is none: commit the ticket's staged changes yourself first (${n.uncommitted.join(', ')}), then run board commit-record ${t.id} <sha>`
        : `done but not committed: ${n.uncommitted.join(', ')}`);
      if (!tk.finalRun) reasons.push('all tests together (board test-all) not run yet');
      else if (!tk.finalRun.ok) reasons.push('all tests together failed on the last run');
    }
    const dirty = wt && fs.existsSync(wt)
      ? worktreeChanges(t).work : [];
    if (dirty.length) reasons.push(`${dirty.length} uncommitted file(s) in the worktree`);
    const base = t.baseBranch || this.detectBase();
    const range = t.branch ? `${base}..${t.branch}` : null;
    const commits = range ? (tryGit(['log', '--no-merges', '--format=%s', range], this.root) || '').split('\n').filter(Boolean) : [];
    if (t.branch && !commits.length) reasons.push(`no commits on ${t.branch} that ${base} doesn't have`);
    const upstream = t.branch ? tryGit(['rev-parse', '--abbrev-ref', `${t.branch}@{upstream}`], this.root) : null;
    const unpushed = upstream ? (tryGit(['log', '--oneline', `${upstream}..${t.branch}`], this.root) || '').split('\n').filter(Boolean).length : null;
    const round = t.round || 1;
    return {
      id: t.id, ready: reasons.length === 0, reasons, branch: t.branch, base, worktree: wt, round, hasTasks: this.hasTasks(t.id),
      upstream, unpushed, pushed: !!upstream && unpushed === 0, gh: this.hasGh(), ghMode: this.config().pr.gh, pr: t.pr || null,
      compareUrl: t.branch ? this.compareUrl(base, t.branch) : null,
      // Minimal description: the title plus a few lines of what changed.
      title: `${t.id}: ${t.title}${round > 1 ? ` (round ${round})` : ''}`,
      body: [...commits.slice(0, 8).reverse().map(c => `- ${c}`), commits.length > 8 ? `- …and ${commits.length - 8} more` : '', '', `Ticket: ${t.id}${round > 1 ? `, round ${round}` : ''}`]
        .filter((l, i, a) => l || (i > 0 && a[i - 1])).join('\n').trim()
    };
  }

  // Push the ticket's branch to origin (never forced). Async with a timeout and no credential prompts, so
  // the board server never hangs waiting for input; git uses the credentials it already has.
  pushBranch(id, { actor } = {}) {
    const t = this.get(id);
    if (!t.branch) throw new Error(`${t.id} has no branch to push`);
    const cwd = t.worktree && fs.existsSync(t.worktree) ? t.worktree : this.root;
    if (tryGit(['remote', 'get-url', 'origin'], this.root) === null) throw new Error('This repo has no "origin" remote to push to');
    return new Promise((resolve, reject) => {
      // Own process group (detached), so a timeout also kills the ssh child git started.
      const p = spawn('git', ['push', '-u', 'origin', `refs/heads/${t.branch}:refs/heads/${t.branch}`], {
        cwd, detached: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }
      });
      let out = '', timedOut = false;
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { out += d; });
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-p.pid, 'SIGKILL'); } catch { p.kill('SIGKILL'); }
      }, 60000);
      const fail = msg => reject(Object.assign(new Error(msg), { stderr: msg }));
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('close', code => {
        clearTimeout(timer);
        out = out.slice(-4000).trim();
        if (timedOut) return fail(`Push timed out after 60s${out ? `: ${out}` : ''}. Check your network and that git can push without asking for a password`);
        if (code !== 0) return fail(`Push failed: ${out || `git exited with ${code}`}`);
        this.log(t.id, 'pushed', { branch: t.branch }, actor);
        resolve({ pushed: true, branch: t.branch, output: out });
      });
    });
  }

  // Browser link to open a PR without gh (GitHub remotes only; null for others).
  compareUrl(base, branch) {
    const u = tryGit(['remote', 'get-url', 'origin'], this.root) || '';
    const m = u.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
    if (!m) return null;
    const enc = s => s.split('/').map(encodeURIComponent).join('/');
    return `https://github.com/${m[1]}/${m[2]}/compare/${enc(base)}...${enc(branch)}?expand=1`;
  }

  // Record the PR that was opened for the ticket's current round, and move the card to review.
  recordPr(id, { url, number, state = 'open' } = {}, actor) {
    const t = this.get(id);
    const u = String(url || '').trim();
    if (u && !/^https:\/\/\S+\/pull\/\d+/.test(u)) throw new Error(`Not a pull request URL: ${u}`);
    const num = Number(number || (u.match(/\/pull\/(\d+)/) || [])[1]);
    if (!num) throw new Error('Give the PR URL (or its number)');
    if (!['open', 'merged', 'closed'].includes(state)) throw new Error('PR state must be open, merged or closed');
    t.pr = { number: num, url: u || null, state, round: t.round || 1, branch: t.branch, base: t.baseBranch, opened: now() };
    if (this.config().columns.includes('review') && state === 'open') t.column = 'review';
    this.save(t);
    this.log(t.id, 'pr-opened', { pr: num, url: t.pr.url, round: t.pr.round }, actor);
    return t;
  }

  // Refresh the PR's state from GitHub (needs gh). Without gh, the state is left as recorded.
  refreshPr(id, actor) {
    const t = this.get(id);
    if (!t.pr) return { pr: null };
    let raw;
    try {
      raw = this.gh(['pr', 'view', String(t.pr.url || t.pr.number), '--json', 'state,mergedAt,url,number,reviewDecision'], t.worktree && fs.existsSync(t.worktree) ? t.worktree : this.root);
    } catch (e) {
      return { pr: t.pr, gh: true, error: String(e.stderr || e.message).trim() };
    }
    if (raw === undefined) return { pr: t.pr, gh: false };
    const v = JSON.parse(raw);
    const state = String(v.state || '').toLowerCase();
    return { pr: this.setPrState(t.id, state, { mergedAt: v.mergedAt || null, reviewDecision: v.reviewDecision || null, url: v.url }, actor).pr, gh: true };
  }

  // Also used directly when gh isn't installed: board pr-state <id> merged.
  setPrState(id, state, extra = {}, actor) {
    const t = this.get(id);
    if (!t.pr) throw new Error(`${t.id} has no PR recorded`);
    if (!['open', 'merged', 'closed'].includes(state)) throw new Error('PR state must be open, merged or closed');
    const before = t.pr.state;
    t.pr = { ...t.pr, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)), state, checked: now() };
    if (state === 'merged' && !t.pr.mergedAt) t.pr.mergedAt = now();
    this.save(t);
    if (before !== state) this.log(t.id, 'pr-state', { pr: t.pr.number, from: before, to: state }, actor);
    return t;
  }

  // After the PR is merged: remove the worktree (and optionally the local branch), move to done.
  // The ticket, plan, tasks and history all stay, so a later QA or client change can reopen it.
  cleanup(id, { deleteBranch = false, actor } = {}) {
    const t = this.get(id);
    if (!t.pr || t.pr.state !== 'merged') throw new Error(`${t.id}'s PR isn't merged${t.pr ? ` (it's ${t.pr.state})` : ''}; clean up only after the merge`);
    const check = this.deleteCheck(t.id);
    // A squash or rebase merge leaves the branch's own commits off the base, but they're on the remote: only
    // work no remote has (or uncommitted files) would be lost.
    if (!check.safe) throw new Error(`Not safe to clean up ${t.id}: ${check.reasons.join('; ')}`);
    const done = [];
    if (check.worktreeExists && !check.isMain) {
      // --force: only the files setup created (.env, launch.json) are left, which plain remove refuses.
      git(['worktree', 'remove', '--force', t.worktree], this.root);
      done.push(`removed worktree ${t.worktree}`);
    }
    tryGit(['worktree', 'prune'], this.root);
    if (deleteBranch && t.branch && !check.isMain && t.branch !== this.currentBranch(this.root)) {
      done.push(tryGit(['branch', '-D', t.branch], this.root) !== null ? `deleted local branch ${t.branch}` : `kept local branch ${t.branch} (git refused to delete it)`);
    }
    const t2 = this.get(t.id);
    if (!check.isMain) t2.worktree = null;
    t2.column = 'done';
    t2.cleanedUp = now();
    this.save(t2);
    this.log(t.id, 'cleaned-up', { pr: t.pr.number, done }, actor);
    return { ticket: t2, done };
  }

  // A merged ticket gets QA bugs or client changes: same ticket and history, a new round with its own plan
  // section, tasks, branch (from the latest base), worktree and PR. Earlier rounds stay readable.
  reopen(id, { reason, type, actor } = {}) {
    const t = this.get(id);
    if (!reason || !String(reason).trim()) throw new Error('Say what changed: the QA issue or the client request');
    if (t.column !== 'done' && t.pr?.state !== 'merged') throw new Error(`${t.id} isn't done or merged yet; keep working in its current round`);
    if (t.worktree && fs.existsSync(t.worktree) && path.resolve(t.worktree) !== path.resolve(this.root)) {
      throw new Error(`${t.id}'s worktree ${t.worktree} still exists. Clean it up first (board cleanup ${t.id}) so the new round starts from the latest base`);
    }
    if (type && !this.config().branch.types.includes(type)) throw new Error(`Unknown branch type ${type}`);
    const round = t.round || 1;
    const archive = `tasks-r${round}.json`;
    if (fs.existsSync(this.tasksFile(t.id))) fs.renameSync(this.tasksFile(t.id), path.join(this.tdir(t.id), archive));
    const next = round + 1;
    const header = `## Round ${next}: ${String(reason).trim().split('\n')[0]}`;
    const plan = this.plan(t.id).replace(/\s*$/, '');
    // writePlan keeps the previous plan as a version and re-syncs a shared copy.
    this.writePlan(t.id, `${plan}\n\n${header}\n\nReopened ${now().slice(0, 10)}.\n\n${String(reason).trim()}\n\n### Plan for this round\n(to be planned)\n`, { source: 'reopen', actor, note: `round ${next}` });
    const t2 = this.get(t.id);
    t2.rounds = [...(t2.rounds || []), {
      round, branch: t2.branch, baseBranch: t2.baseBranch, pr: t2.pr || null, tasks: fs.existsSync(path.join(this.tdir(t.id), archive)) ? archive : null, closed: now()
    }];
    t2.round = next;
    t2.reopenReason = String(reason).trim();
    t2.pr = null;
    t2.branch = null;
    t2.baseBranch = null;
    t2.worktree = null;
    t2.planStatus = 'drafting';
    t2.column = 'planning';
    let name = `${this.branchName(t2, { type: type || t2.type })}-r${next}`;
    for (let i = 2; this.branchExists(name); i++) name = `${this.branchName(t2, { type: type || t2.type })}-r${next}-${i}`;
    t2.plannedBranch = name;
    this.save(t2);
    this.log(t.id, 'reopened', { round: next, reason: t2.reopenReason, plannedBranch: name }, actor);
    return t2;
  }

  // Earlier rounds, for context: branch, PR and the task titles that were built.
  roundsSummary(id) {
    const t = this.get(id);
    if (!(t.rounds || []).length) return '';
    return ['\n## Earlier rounds', ...t.rounds.map(r => {
      const tk = r.tasks ? readJSON(path.join(this.tdir(t.id), r.tasks), { tasks: [] }) : { tasks: [] };
      const pr = r.pr ? ` PR #${r.pr.number} ${r.pr.state}${r.pr.url ? ` ${r.pr.url}` : ''}` : ' no PR';
      return [`Round ${r.round}: ${r.branch || '-'}${pr}`, ...tk.tasks.map(x => `  - ${x.id} ${x.title}${x.commit ? ` @${x.commit.slice(0, 7)}` : ''}`)].join('\n');
    }), `Round ${t.round || 1} (now): ${t.reopenReason || ''}`].join('\n');
  }

  // Changes whenever anything under .board changes; the UI polls this.
  rev() {
    let max = 0;
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else max = Math.max(max, fs.statSync(p).mtimeMs);
      }
    };
    if (fs.existsSync(this.dir)) walk(this.dir);
    return String(max);
  }
}

module.exports = { Board, DEFAULT_CONFIG, PLAN_STATUSES, TASK_STATUSES, slugify };
