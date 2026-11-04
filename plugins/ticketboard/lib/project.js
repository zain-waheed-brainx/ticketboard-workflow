// Project profile: how this repo installs, runs and tests, and what a fresh worktree needs.
// Lives in ticketboard.project.json at the repo root (committed, shared with the team).
// detect() proposes one from the files in the repo; doctor() checks the tools it needs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const FILE = 'ticketboard.project.json';
// Gitignored files a worktree usually needs copied from the main checkout.
const COPY_CANDIDATES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.test',
  'config/master.key', 'config/credentials.yml.enc', 'auth.json', '.npmrc', 'local.settings.json'];

const exists = (root, f) => fs.existsSync(path.join(root, f));
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function tryRun(cmd, args, cwd) {
  try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim(); } catch { return null; }
}

function load(root) { return readJSON(path.join(root, FILE)); }

function save(root, profile) {
  fs.writeFileSync(path.join(root, FILE), JSON.stringify(profile, null, 2) + '\n');
  return path.join(root, FILE);
}

// Every part that runs commands (setup, dev, test, build, lint); trusting is per machine (.board/trusted.json).
function commandHash(profile) {
  if (!profile) return null;
  const c = profile.commands || {};
  const runs = { copyFiles: profile.worktree?.copyFiles || [], setup: profile.worktree?.setup || [], dev: c.dev || [], test: c.test || null, build: c.build || null, lint: c.lint || null };
  return crypto.createHash('sha256').update(JSON.stringify(runs)).digest('hex').slice(0, 16);
}

function nodeProfile(root, pkg, out) {
  const pm = exists(root, 'pnpm-lock.yaml') ? 'pnpm' : exists(root, 'yarn.lock') ? 'yarn'
    : exists(root, 'bun.lockb') || exists(root, 'bun.lock') ? 'bun' : 'npm';
  const lock = pm !== 'npm' || exists(root, 'package-lock.json');
  const install = { npm: lock ? 'npm ci' : 'npm install', pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', bun: 'bun install' }[pm];
  const run = s => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
  const scripts = pkg.scripts || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  out.stack.push('node');
  out.tools.push('node', pm);
  out.worktree.setup.push(install);
  // Laravel Mix: "dev" is a one-off asset build, not a server. Build assets during setup instead.
  if (deps['laravel-mix'] && scripts.dev && !/serve|--watch|hot/.test(scripts.dev)) {
    out.worktree.setup.push(run('dev'));
    const prod = ['prod', 'production', 'build'].find(s => scripts[s]);
    if (prod) out.commands.build = out.commands.build || run(prod);
    out.evidence.push('laravel-mix');
  }
  const devScript = deps['laravel-mix'] ? null : ['dev', 'start', 'serve'].find(s => scripts[s]);
  if (devScript) {
    const s = scripts[devScript];
    const m = s.match(/(?:--port[ =]|-p\s+)(\d{2,5})/);
    const port = m ? Number(m[1]) : deps.vite || /\bvite\b/.test(s) ? 5173 : deps['@angular/core'] ? 4200
      : deps.next || deps.nuxt || deps['react-scripts'] || deps.express ? 3000 : null;
    out.commands.dev.push({ name: pkg.name || 'web', command: run(devScript), port, detectedFrom: `package.json scripts.${devScript}` });
    if (!port) out.unsure.push(`Port for "${run(devScript)}"`);
  }
  if (scripts.test && !/no test specified/.test(scripts.test)) out.commands.test = out.commands.test || run('test');
  if (scripts.build) out.commands.build = out.commands.build || run('build');
  if (scripts.lint) out.commands.lint = out.commands.lint || run('lint');
  const nv = readText(path.join(root, '.nvmrc')).trim() || readText(path.join(root, '.node-version')).trim() || pkg.engines?.node;
  if (nv) out.versions.node = nv;
}

// Root has no stack of its own (e.g. backend/ + frontend/): detect each top-level folder
// and prefix its commands with "cd <dir> &&".
function mergeSubprojects(root, out) {
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'vendor', 'docs'].includes(e.name));
  const tests = [], builds = [], repos = [];
  for (const { name } of dirs) {
    const sub = detect(path.join(root, name), 1);
    if (!sub.stack.length) continue;
    if (exists(path.join(root, name), '.git')) repos.push(name);
    const q = /^[\w.-]+$/.test(name) ? name : `"${name}"`;
    out.stack.push(...sub.stack);
    out.tools.push(...sub.tools);
    out.evidence.push(...sub.evidence.map(e => `${name}/${e}`));
    out.worktree.setup.push(...sub.worktree.setup.map(s => `cd ${q} && ${s}`));
    out.worktree.copyFiles.push(...sub.worktree.copyFiles.map(f => `${name}/${f}`));
    out.commands.dev.push(...sub.commands.dev.map(d => ({ ...d, name: name, command: `cd ${q} && ${d.command}`, detectedFrom: `${name}/${d.detectedFrom}` })));
    if (sub.commands.test) tests.push(`(cd ${q} && ${sub.commands.test})`);
    if (sub.commands.build) builds.push(`(cd ${q} && ${sub.commands.build})`);
    out.unsure.push(...sub.unsure.map(u => `${name}: ${u}`));
  }
  if (tests.length) out.commands.test = tests.join(' && ');
  if (builds.length) out.commands.build = builds.join(' && ');
  out.stack = [...new Set(out.stack)];
  if (repos.length) {
    out.separateRepos = repos;
    out.unsure.unshift(`${repos.join(' and ')} ${repos.length > 1 ? 'are separate git repos' : 'is its own git repo'}: worktrees are per repo, so set up ticketboard inside ${repos.length > 1 ? 'each one' : 'it'} (or make the parent folder one repo)`);
  }
  const ports = out.commands.dev.map(d => d.port).filter(Boolean);
  if (new Set(ports).size < ports.length) out.unsure.push(`Two apps use the same dev port (${ports.join(', ')}); give one a different port`);
}

function detect(root, depth = 0) {
  const out = {
    name: path.basename(root), stack: [], tools: ['git'], versions: {},
    baseBranch: null,
    commands: { install: [], dev: [], test: null, build: null, lint: null },
    worktree: { copyFiles: [], setup: [], launch: true },
    unsure: [], evidence: []
  };
  const pkg = readJSON(path.join(root, 'package.json'));
  const composer = readJSON(path.join(root, 'composer.json'));

  if (composer) {
    out.stack.push('php');
    out.tools.push('php', 'composer');
    out.worktree.setup.push('composer install');
    out.evidence.push('composer.json');
    if (exists(root, 'artisan')) {
      out.stack.push('laravel');
      out.commands.dev.push({ name: 'laravel', command: 'php artisan serve --port=8000', port: 8000, detectedFrom: 'artisan' });
      out.commands.test = 'php artisan test';
      if (!exists(root, '.env') && exists(root, '.env.example')) {
        out.worktree.setup.push('cp .env.example .env', 'php artisan key:generate');
      }
    } else if (composer.scripts?.test) out.commands.test = 'composer test';
  }
  if (pkg) {
    out.evidence.push('package.json');
    nodeProfile(root, pkg, out);
  }
  if (exists(root, 'pyproject.toml') || exists(root, 'requirements.txt')) {
    out.stack.push('python');
    out.tools.push('python3');
    out.evidence.push(exists(root, 'pyproject.toml') ? 'pyproject.toml' : 'requirements.txt');
    const usesUv = exists(root, 'uv.lock'), usesPoetry = /\[tool\.poetry\]/.test(readText(path.join(root, 'pyproject.toml')));
    if (usesUv) { out.tools.push('uv'); out.worktree.setup.push('uv sync'); }
    else if (usesPoetry) { out.tools.push('poetry'); out.worktree.setup.push('poetry install'); }
    else out.worktree.setup.push(`python3 -m venv .venv && .venv/bin/pip install ${exists(root, 'requirements.txt') ? '-r requirements.txt' : '-e .'}`);
    if (exists(root, 'manage.py')) {
      out.stack.push('django');
      out.commands.dev.push({ name: 'django', command: `${usesUv ? 'uv run' : usesPoetry ? 'poetry run' : '.venv/bin/python'} python manage.py runserver 8000`.replace('python python', 'python'), port: 8000, detectedFrom: 'manage.py' });
      out.commands.test = out.commands.test || 'python manage.py test';
    } else out.commands.test = out.commands.test || 'pytest';
  }
  if (exists(root, 'Gemfile')) {
    out.stack.push('ruby');
    out.tools.push('ruby', 'bundle');
    out.worktree.setup.push('bundle install');
    out.evidence.push('Gemfile');
    if (exists(root, 'bin/rails')) {
      out.stack.push('rails');
      out.commands.dev.push({ name: 'rails', command: 'bin/rails server -p 3000', port: 3000, detectedFrom: 'bin/rails' });
      out.commands.test = out.commands.test || 'bin/rails test';
    }
  }
  if (exists(root, 'go.mod')) {
    out.stack.push('go'); out.tools.push('go'); out.evidence.push('go.mod');
    out.worktree.setup.push('go mod download');
    out.commands.test = out.commands.test || 'go test ./...';
  }
  if (exists(root, 'Cargo.toml')) {
    out.stack.push('rust'); out.tools.push('cargo'); out.evidence.push('Cargo.toml');
    out.commands.test = out.commands.test || 'cargo test';
    out.commands.build = out.commands.build || 'cargo build';
  }
  const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find(f => exists(root, f));
  if (compose) {
    out.tools.push('docker');
    out.evidence.push(compose);
    out.notes = `Has ${compose}; services may need "docker compose up -d" before dev.`;
    out.unsure.push(`Whether ${compose} services must run for dev`);
  }
  const make = readText(path.join(root, 'Makefile'));
  if (make) {
    out.evidence.push('Makefile');
    const targets = new Set([...make.matchAll(/^([a-zA-Z][\w-]*):/gm)].map(m => m[1]));
    if (targets.has('setup') || targets.has('install')) out.unsure.push(`Makefile has "${targets.has('setup') ? 'setup' : 'install'}"; use it instead of the detected setup?`);
    if (!out.commands.test && targets.has('test')) out.commands.test = 'make test';
    if (!out.commands.dev.length && (targets.has('dev') || targets.has('run'))) {
      out.commands.dev.push({ name: 'app', command: `make ${targets.has('dev') ? 'dev' : 'run'}`, port: null, detectedFrom: 'Makefile' });
      out.unsure.push('Port for the make dev target');
    }
  }
  // Files the main checkout has, git ignores, and a new worktree would be missing.
  for (const f of COPY_CANDIDATES) {
    if (exists(root, f) && tryRun('git', ['check-ignore', '-q', f], root) !== null) out.worktree.copyFiles.push(f);
  }
  if (!exists(root, '.env') && exists(root, '.env.example') && !out.worktree.setup.some(s => s.includes('.env.example'))) {
    out.worktree.setup.unshift('cp .env.example .env');
    out.unsure.push('.env is created from .env.example; does it need real values?');
  }
  if (!out.stack.length && depth === 0) mergeSubprojects(root, out);
  out.commands.install = [...out.worktree.setup];
  if (depth > 0) return out;
  const originHead = tryRun('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  const common = ['main', 'master', 'develop'].find(b => tryRun('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], root) !== null);
  out.baseBranch = originHead ? originHead.replace(/^origin\//, '') : common || tryRun('git', ['branch', '--show-current'], root) || 'main';
  if (!originHead && !common) out.unsure.push(`Base branch guessed from the checked-out branch (${out.baseBranch})`);
  if (!out.stack.length) out.unsure.push('No known stack detected: how is this project installed and run?');
  out.tools = [...new Set(out.tools)];
  return out;
}

// Turn a detection into the committed profile (drops working fields).
function toProfile(d, branch) {
  return {
    version: 1,
    name: d.name,
    stack: d.stack,
    baseBranch: d.baseBranch,
    tools: d.tools,
    ...(Object.keys(d.versions || {}).length ? { versions: d.versions } : {}),
    commands: { dev: d.commands.dev.map(({ detectedFrom, ...x }) => x), test: d.commands.test, build: d.commands.build, lint: d.commands.lint },
    worktree: d.worktree,
    ...(branch ? { branch } : {}),
    ...(d.notes ? { notes: d.notes } : {})
  };
}

const VERSION_ARGS = { go: ['version'], bundle: ['--version'], cargo: ['--version'], uv: ['--version'] };
function doctor(tools = ['git']) {
  const res = [];
  for (const t of [...new Set(['git', ...tools])]) {
    const where = tryRun('/bin/sh', ['-c', `command -v ${t.replace(/[^\w.-]/g, '')}`]);
    const version = where ? (tryRun(t, VERSION_ARGS[t] || ['--version']) || '').split('\n')[0] : null;
    res.push({ tool: t, ok: !!where, path: where, version });
  }
  const git = res.find(r => r.tool === 'git');
  const m = git?.version?.match(/(\d+)\.(\d+)/);
  if (m && (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 17))) {
    git.ok = false; git.note = 'git 2.17+ is needed for worktree remove';
  }
  return res;
}

module.exports = { FILE, load, save, detect, toProfile, doctor, commandHash };
