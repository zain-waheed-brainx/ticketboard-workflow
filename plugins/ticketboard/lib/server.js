// Local web board: JSON API over the store plus the single-page UI. Binds to 127.0.0.1 only.
const http = require('http');
const fs = require('fs');
const path = require('path');

const UI = path.join(__dirname, '..', 'ui', 'index.html');
const ACTOR = 'you';

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const MAX_BODY = 5e6;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', c => {
      if (tooBig) return;
      data += c;
      if (data.length > MAX_BODY) { tooBig = true; data = ''; reject(Object.assign(new Error('Request body too large'), { status: 413 })); }
    });
    req.on('end', () => { if (tooBig) return; try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Only the board's own page may call the API: blocks other websites (cross-site requests) and
// DNS-rebinding hosts. Non-GET calls must be JSON, which browsers can't send cross-site without a preflight.
function allowed(req, port) {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  if (!hosts.includes(req.headers.host)) return 'Bad Host header';
  if (!req.url.startsWith('/api/')) return null; // the page itself may be opened from anywhere
  const origin = req.headers.origin;
  if (origin && !hosts.some(h => origin === `http://${h}`)) return 'Cross-origin request refused';
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return 'Cross-site request refused';
  if (req.method !== 'GET' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return 'Content-Type must be application/json';
  return null;
}

const adoptResult = r => ({ changes: r.changes, commits: r.commits, files: r.files, mainNowOn: r.mainNowOn, movedBranch: r.movedBranch });

// Worktree setup can take minutes (npm ci, composer install): run it after responding.
function setupInBackground(b, t) {
  if (!t.worktree || t.worktree === b.root || !b.profile()) return t;
  b.bootstrap(t.id, { actor: ACTOR }).catch(e => console.error(`bootstrap ${t.id}: ${e.message}`));
  return { ...t, bootstrap: { status: 'running' } };
}

function routes(b) {
  return [
    ['GET', /^\/api\/git-branches$/, () => b.gitBranches()],
    ['GET', /^\/api\/current-work$/, () => b.currentWork()],
    ['POST', /^\/api\/tickets\/([\w-]+)\/adopt$/, ([, id], body) => {
      const r = b.adopt(id, { branch: body.branch, actor: ACTOR });
      return { ...setupInBackground(b, r.ticket), adopt: adoptResult(r) };
    }],
    ['GET', /^\/api\/project$/, () => ({ profile: b.profile(), trusted: b.trusted() })],
    ['GET', /^\/api\/tickets\/([\w-]+)\/bootstrap$/, ([, id]) => ({ log: b.bootstrapLog(id), status: b.get(id).bootstrap || null })],
    ['POST', /^\/api\/tickets\/([\w-]+)\/bootstrap$/, ([, id]) => setupInBackground(b, b.get(id))],
    ['GET', /^\/api\/rev$/, () => ({ rev: b.rev() })],
    ['GET', /^\/api\/state$/, () => ({
      root: b.root, config: b.config(), rev: b.rev(),
      tickets: b.list().map(t => {
        const n = b.hasTasks(t.id) ? b.nextTasks(t.id) : null;
        return n ? { ...t, progress: { done: n.done, total: n.total, stale: n.stale } } : t;
      }),
      project: { exists: !!b.profile(), trusted: b.trusted() }
    })],
    // branchMode: 'later' saves the name on the ticket; 'new' creates branch (+ worktree) now; 'current' links the checked-out branch.
    ['POST', /^\/api\/tickets$/, (m, body) => {
      const { branchMode = 'later', branch, worktree = true, base, savePattern, ...fields } = body;
      if (branch && !b.validBranch(branch)) throw new Error(`Invalid branch name: ${branch}`);
      if (savePattern) b.savePattern(savePattern, true);
      const t = b.create({ ...fields, plannedBranch: branchMode === 'current' ? null : branch || null }, ACTOR);
      if (branchMode === 'later') return t;
      if (branchMode === 'adopt') {
        try {
          const r = b.adopt(t.id, { branch: branch || undefined, actor: ACTOR });
          return { ...setupInBackground(b, r.ticket), adopt: adoptResult(r) };
        } catch (e) {
          return { ...b.get(t.id), warning: `Ticket created, but your work wasn't moved: ${e.message}` };
        }
      }
      try {
        const started = b.start(t.id, { branch, useCurrent: branchMode === 'current', worktree, base, actor: ACTOR });
        return branchMode === 'new' ? setupInBackground(b, started) : started;
      } catch (e) {
        return { ...b.get(t.id), warning: `Ticket created, but the branch could not be started: ${e.stderr ? String(e.stderr).trim() : e.message}` };
      }
    }],
    ['GET', /^\/api\/tickets\/([\w-]+)$/, ([, id]) => ({
      ticket: b.get(id), plan: b.plan(id), grill: b.grill(id), history: b.history(id), versions: b.versions(id),
      tasks: b.tasks(id), next: b.nextTasks(id)
    })],
    ['PATCH', /^\/api\/tickets\/([\w-]+)\/tasks\/([\w-]+)$/, ([, id, tid], body) => b.updateTask(id, tid, body, ACTOR)],
    ['POST', /^\/api\/tickets\/([\w-]+)\/tasks\/([\w-]+)\/test$/, ([, id, tid], body) => b.runTaskTest(id, tid, body.phase || 'after', { actor: ACTOR })],
    ['POST', /^\/api\/tickets\/([\w-]+)\/test-all$/, ([, id]) => b.runAllTests(id, { actor: ACTOR })],
    ['PUT', /^\/api\/tickets\/([\w-]+)\/build-mode$/, ([, id], body) => b.setBuildMode(id, body.mode, ACTOR)],
    ['PUT', /^\/api\/tickets\/([\w-]+)\/commit-mode$/, ([, id], body) => b.setCommitMode(id, body.mode, ACTOR)],
    ['PUT', /^\/api\/tickets\/([\w-]+)\/run-mode$/, ([, id], body) => b.setRunMode(id, body.mode, ACTOR)],
    ['PUT', /^\/api\/tickets\/([\w-]+)\/done-when\/(\d+)$/, ([, id, n], body) => b.checkDoneWhen(id, Number(n), body.checked !== false, ACTOR)],
    ['PATCH', /^\/api\/tickets\/([\w-]+)$/, ([, id], body) => b.update(id, body, ACTOR)],
    ['GET', /^\/api\/tickets\/([\w-]+)\/pr-check$/, ([, id]) => b.prCheck(id)],
    ['POST', /^\/api\/tickets\/([\w-]+)\/push$/, ([, id], body) => {
      if (body.confirm !== true) throw new Error('Pushing needs confirm: true');
      return b.pushBranch(id, { actor: ACTOR });
    }],
    // Refreshing asks GitHub and may update the ticket, so it's a POST.
    ['POST', /^\/api\/tickets\/([\w-]+)\/pr\/refresh$/, ([, id]) => b.refreshPr(id, ACTOR)],
    ['PUT', /^\/api\/tickets\/([\w-]+)\/pr$/, ([, id], body) => (body.url || body.number
      ? b.recordPr(id, { url: body.url, number: body.number }, ACTOR) : b.setPrState(id, body.state, {}, ACTOR))],
    ['POST', /^\/api\/tickets\/([\w-]+)\/cleanup$/, ([, id], body) => b.cleanup(id, { deleteBranch: !!body.deleteBranch, actor: ACTOR })],
    ['POST', /^\/api\/tickets\/([\w-]+)\/reopen$/, ([, id], body) => b.reopen(id, { reason: body.reason, type: body.type || undefined, actor: ACTOR })],
    ['GET', /^\/api\/tickets\/([\w-]+)\/delete-check$/, ([, id]) => b.deleteCheck(id)],
    ['DELETE', /^\/api\/tickets\/([\w-]+)$/, ([, id], body) => b.delete(id, { force: !!body.force, confirm: body.confirm, deleteBranch: !!body.deleteBranch, actor: ACTOR })],
    ['PUT', /^\/api\/tickets\/([\w-]+)\/plan$/, ([, id], body) => b.writePlan(id, body.content || '', { actor: ACTOR, source: body.source })],
    ['GET', /^\/api\/tickets\/([\w-]+)\/versions\/([\w.-]+)$/, ([, id, name]) => ({ content: b.version(id, name) })],
    ['POST', /^\/api\/tickets\/([\w-]+)\/note$/, ([, id], body) => b.addSession(id, body.text || '', ACTOR)],
    ['POST', /^\/api\/tickets\/([\w-]+)\/share$/, ([, id], body) => b.share(id, body.on !== false, ACTOR)],
    ['GET', /^\/api\/tickets\/([\w-]+)\/branches$/, ([, id], body, q) => b.branchOptions(id, q.get('type') || undefined, q.get('pattern'))],
    ['GET', /^\/api\/branch-preview$/, (m, body, q) =>
      b.branchOptionsDraft({ title: q.get('title') || '', type: q.get('type') || undefined }, q.get('pattern'))],
    ['POST', /^\/api\/tickets\/([\w-]+)\/start$/, ([, id], body) => {
      if (body.savePattern) b.savePattern(body.savePattern, true);
      const t = b.start(id, { ...body, actor: ACTOR });
      return body.useCurrent ? t : setupInBackground(b, t);
    }],
    ['GET', /^\/api\/tickets\/([\w-]+)\/context$/, ([, id]) => ({ context: b.context(id) })],
    ['PUT', /^\/api\/config$/, (m, body) => {
      if (body.addType) b.addType(body.addType);
      if (body.savePattern) b.savePattern(body.savePattern, body.makeDefault !== false);
      if (body.branch) b.saveConfig({ branch: body.branch });
      return b.config();
    }]
  ];
}

function serve(b, port) {
  const table = routes(b);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const refused = allowed(req, port);
    if (refused) return send(res, 403, { error: refused });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(UI, 'utf8'), 'text/html; charset=utf-8');
    }
    for (const [method, re, fn] of table) {
      const m = url.pathname.match(re);
      if (!m || req.method !== method) continue;
      try {
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        return send(res, 200, await fn(m, body, url.searchParams));
      } catch (e) {
        return send(res, e.status || 400, { error: e.stderr ? String(e.stderr).trim() : e.message });
      }
    }
    send(res, 404, { error: 'Not found' });
  });
  server.listen(port, '127.0.0.1', () => console.log(`Ticketboard for ${b.root}\nhttp://localhost:${port}`));
  server.on('error', e => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} in use. Try: board serve --port ${port + 1}` : e.message);
    process.exit(1);
  });
}

module.exports = { serve };
