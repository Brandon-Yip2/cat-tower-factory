// Local HTTP API + dashboard. Binds 127.0.0.1; mutating requests need the install's secret
// token and a same-origin (or absent) Origin, so web pages can't drive agents via localhost.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { changeSeq, kvSet, tokensUsedSince, startOfToday, logActivity } from './db.mjs';
import { UI_DIR, REPO_ROOT } from './paths.mjs';
import { roleById } from './config.mjs';
import { createIdea, getIdea, listIdeas, stageCounts, updateIdea, decideApproval, STATUSES, unmetDeps } from './ideas.mjs';
import { openQuestions, chatHistory } from './questions.mjs';
import { resourceView, forceRelease, liveFileClaims } from './resources.mjs';
import { loopView, setEnabled, fireLoop } from './scheduler.mjs';
import { budgetState, isPaused } from './dispatcher.mjs';
import { routingTable, rate, REDO_REASONS } from './routing.mjs';
import { roleName } from './snapshot.mjs';
import { notify } from './notify.mjs';
import { openApp, appStatus } from './apps.mjs';
import { pendingProposals, approvePass, denyPass } from './proposals.mjs';
import { readyWork } from './dispatcher.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 1e6) throw new HttpError(413, 'body too large'); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'invalid JSON'); }
}

const weekAgo = () => new Date(Date.now() - 7 * 86400_000).toISOString();

export function createApi({ db, getCfg, runner, secret, port }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

  const homeView = () => {
    const cfg = getCfg();
    const runs = db.prepare(`SELECT r.*, i.title AS idea_title FROM runs r LEFT JOIN ideas i ON i.id = r.idea_id
      WHERE (r.kind = 'factory' AND r.status IN ('running','parked'))
         OR (r.kind = 'interactive' AND r.status IN ('running','idle') AND r.last_activity_at >= ?)
      ORDER BY r.started_at`).all(new Date(Date.now() - 30 * 60_000).toISOString());
    const budget = budgetState(db, cfg);
    return {
      pass: cfg.settings.currentPass,
      needsYou: openQuestions(db).map((q) => ({ ...q, roleName: roleName(cfg, q.role) })),
      proposals: pendingProposals(db, cfg).map((p) => ({ ...p, createdByName: roleName(cfg, p.created_by) })),
      working: runs.map((r) => ({ ...r, roleName: roleName(cfg, r.role), live: r.kind === 'interactive' || runner.isActive(r.id) })),
      tools: toolsView(),
      comingUp: loopView(db, cfg).filter((l) => l.next).sort((a, b) => a.next.localeCompare(b.next)).slice(0, 4),
      pipeline: stageCounts(db, cfg.settings.currentPass || null),
      totals: { tokensToday: budget.used, budget: budget.limit, budgetReached: budget.exhausted, paused: isPaused(db),
        costToday: db.prepare('SELECT COALESCE(SUM(cost_usd),0) c FROM runs WHERE started_at >= ?').get(startOfToday()).c,
        running: runner.activeCount(), maxConcurrent: cfg.guards.maxConcurrentRuns },
    };
  };

  const toolsView = () => {
    const cfg = getCfg();
    return {
      resources: resourceView(db, cfg).map((r) => ({
        ...r,
        holders: r.holders.map((h) => ({ ...h, roleName: roleName(cfg, h.role), ideaTitle: h.idea_id ? db.prepare('SELECT title FROM ideas WHERE id = ?').get(h.idea_id)?.title : null })),
        queue: r.queue.map((q) => ({ ...q, roleName: roleName(cfg, q.role) })),
        last: r.last ? { ...r.last, roleName: roleName(cfg, r.last.role) } : null,
      })),
      files: liveFileClaims(db).map((c) => ({ ...c, roleName: roleName(cfg, c.role) })),
      apps: appStatus(cfg),
    };
  };

  route('GET', '/api/home', () => homeView());

  route('GET', '/api/ideas', (req, url) => {
    const cfg = getCfg();
    const q = Object.fromEntries(url.searchParams);
    const pass = q.pass === 'all' ? null : (q.pass || cfg.settings.currentPass || null);
    const ideas = listIdeas(db, { status: q.status, stageGroup: q.group, area: q.area, origin: q.origin, ownerRole: q.owner, pass, q: q.q });
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const countRows = db.prepare(`SELECT status, COUNT(*) n FROM ideas ${pass ? 'WHERE pass_label = ?' : ''} GROUP BY status`).all(...(pass ? [pass] : []));
    for (const r of countRows) counts[r.status] = r.n;
    const passes = db.prepare('SELECT DISTINCT pass_label p FROM ideas WHERE pass_label IS NOT NULL ORDER BY p DESC').all().map((r) => r.p);
    return { ideas: ideas.map((i) => ({ ...i, waiting: unmetDeps(db, i), ownerName: roleName(cfg, i.owner_role), originName: i.origin_role ? roleName(cfg, i.origin_role) : null })), counts, passes, pass, areas: cfg.areas };
  });
  route('GET', '/api/ideas/:id', (req, url, p) => {
    const cfg = getCfg();
    const idea = getIdea(db, Number(p.id));
    if (!idea) throw new HttpError(404, 'idea not found');
    return { ...idea, ownerName: roleName(cfg, idea.owner_role), runs: idea.runs.map((r) => ({ ...r, roleName: roleName(cfg, r.role) })),
      events: idea.events.map((e) => ({ ...e, actorName: roleName(cfg, e.actor) })), redoReasons: REDO_REASONS };
  });
  route('POST', '/api/ideas', (req, url, p, body) => {
    const idea = createIdea(db, getCfg(), { title: body.title, description: body.description, area: body.area || null, kind: body.kind || 'feature',
      priority: body.priority, parentId: body.parentId || null, origin: 'owner', originRole: 'owner' });
    return idea;
  });
  route('POST', '/api/ideas/:id/approve', (req, url, p, body) => decideApproval(db, getCfg(), Number(p.id), true, body.note || ''));
  route('POST', '/api/ideas/:id/reject', (req, url, p, body) => decideApproval(db, getCfg(), Number(p.id), false, body.note || ''));
  route('POST', '/api/ideas/:id/status', (req, url, p, body) => updateIdea(db, getCfg(), Number(p.id), { status: body.status, note: body.note || 'moved by owner' }, 'owner'));
  route('POST', '/api/ideas/:id/rate', (req, url, p, body) => {
    const r = rate(db, getCfg(), { ideaId: Number(p.id), verdict: body.verdict, reason: body.reason, note: body.note });
    if (r.bumped) notify('Model routing changed', `${r.bumped.taskType}: ${r.bumped.from} → ${r.bumped.to} after your redo reviews`);
    return r;
  });

  route('POST', '/api/proposals/:id/approve', (req, url, p, body) => approvePass(db, getCfg(), Number(p.id), body.note || ''));
  route('POST', '/api/proposals/:id/deny', (req, url, p, body) => denyPass(db, Number(p.id), body.reason || ''));

  // The shared backlog, per role: who is working, what is ready next (in order), what waits.
  route('GET', '/api/backlog', () => {
    const cfg = getCfg();
    const ready = new Set(readyWork(db, runner).map((i) => i.id));
    const active = listIdeas(db, { stageGroup: 'active' }).filter((i) => ['approved', 'owner_approved'].includes(i.approval));
    const running = db.prepare(`SELECT r.id, r.role, r.purpose, r.started_at, r.progress_note, r.idea_id, i.title AS idea_title FROM runs r
      LEFT JOIN ideas i ON i.id = r.idea_id WHERE r.kind = 'factory' AND r.status = 'running'`).all().filter((r) => runner.isActive(r.id));
    const roles = cfg.roles.filter((r) => r.builds !== false || running.some((x) => x.role === r.id)).map((r) => {
      const mine = active.filter((i) => (i.owner_role || 'engineering-lead') === r.id && !running.some((x) => x.idea_id === i.id));
      return {
        id: r.id, name: r.name, does: r.does,
        working: running.filter((x) => x.role === r.id),
        next: mine.filter((i) => ready.has(i.id) && i.status !== 'on_hold').map((i) => ({ ...i, waiting: [] })),
        waiting: mine.filter((i) => !ready.has(i.id) || i.status === 'on_hold').map((i) => ({ ...i, waiting: unmetDeps(db, i) })),
      };
    });
    return { proposals: pendingProposals(db, cfg).map((x) => ({ ...x, createdByName: roleName(cfg, x.created_by) })),
      suggestions: listIdeas(db, { status: 'needs_approval' }).map((i) => ({ ...i, originName: roleName(cfg, i.origin_role) })), roles };
  });
  // Move an idea up or down in its role's backlog order.
  route('POST', '/api/ideas/:id/move', (req, url, p, body) => {
    const me = db.prepare('SELECT * FROM ideas WHERE id = ?').get(Number(p.id));
    if (!me) throw new HttpError(404, 'idea not found');
    const peers = db.prepare(`SELECT id, rank FROM ideas WHERE COALESCE(owner_role, 'engineering-lead') = COALESCE(?, 'engineering-lead')
      AND status IN ('triaged','spec','building','staged','qa','on_hold') ORDER BY priority, rank`).all(me.owner_role);
    const at = peers.findIndex((x) => x.id === me.id);
    const other = peers[body.dir === 'up' ? at - 1 : at + 1];
    if (at < 0 || !other) return { moved: false };
    db.transaction(() => {
      db.prepare('UPDATE ideas SET rank = ? WHERE id = ?').run(other.rank, me.id);
      db.prepare('UPDATE ideas SET rank = ? WHERE id = ?').run(peers[at].rank, other.id);
      db.prepare('UPDATE ideas SET priority = ? WHERE id = ?').run(db.prepare('SELECT priority FROM ideas WHERE id = ?').get(other.id).priority, me.id);
    })();
    return { moved: true };
  });

  route('GET', '/api/agents', () => {
    const cfg = getCfg();
    return cfg.roles.map((role) => {
      const current = db.prepare(`SELECT r.*, i.title AS idea_title FROM runs r LEFT JOIN ideas i ON i.id = r.idea_id
        WHERE r.role = ? AND r.kind = 'factory' AND r.status IN ('running','parked') ORDER BY r.started_at DESC LIMIT 1`).get(role.id);
      const last = db.prepare("SELECT id, purpose, status, ended_at, model FROM runs WHERE role = ? AND kind = 'factory' AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1").get(role.id);
      const week = db.prepare(`SELECT COUNT(*) runs, COALESCE(SUM(input_tokens + output_tokens + cache_write),0) tokens,
        SUM(CASE WHEN rating = 'redo' THEN 1 ELSE 0 END) redo FROM runs WHERE role = ? AND started_at >= ?`).get(role.id, weekAgo());
      const unread = db.prepare("SELECT COUNT(*) n FROM messages WHERE from_role = ? AND to_role = 'owner' AND kind = 'reply' AND ts >= ?").get(role.id, weekAgo()).n;
      return { ...role, status: current ? (current.status === 'parked' ? 'waiting' : 'working') : 'idle', current, last, week, replies: unread };
    });
  });
  route('GET', '/api/agents/:role', (req, url, p) => {
    const cfg = getCfg();
    const role = roleById(cfg, p.role);
    if (!role) throw new HttpError(404, 'unknown role');
    return { role, chat: chatHistory(db, role.id),
      runs: db.prepare(`SELECT r.id, r.purpose, r.status, r.model, r.started_at, r.ended_at, r.input_tokens + r.output_tokens + r.cache_write AS tokens,
        r.progress, r.progress_note, i.title AS idea_title FROM runs r LEFT JOIN ideas i ON i.id = r.idea_id WHERE r.role = ? ORDER BY r.started_at DESC LIMIT 25`).all(role.id),
      working: db.prepare("SELECT id FROM runs WHERE role = ? AND kind = 'factory' AND status = 'running'").all(role.id).some((r) => runner.isActive(r.id)) };
  });
  route('POST', '/api/agents/:role/chat', (req, url, p, body) => {
    if (!String(body.text || '').trim()) throw new HttpError(400, 'text is required');
    return runner.chat(p.role, String(body.text).trim());
  });

  route('GET', '/api/loops', () => loopView(db, getCfg()));
  route('POST', '/api/loops/:id/toggle', (req, url, p, body) => { setEnabled(db, p.id, !!body.enabled); return { ok: true }; });
  route('POST', '/api/loops/:id/run', (req, url, p) => {
    const cfg = getCfg();
    const loop = cfg.loops.find((l) => l.id === p.id);
    if (!loop) throw new HttpError(404, 'unknown loop');
    return { runId: fireLoop(db, cfg, runner, loop, { ownerAction: true }) };
  });

  route('GET', '/api/tools', () => toolsView());
  route('POST', '/api/tools/:id/release', (req, url, p) => {
    const n = forceRelease(db, p.id);
    logActivity(db, { role: 'owner', kind: 'gate', summary: `owner force-released ${p.id}` });
    return { released: n };
  });

  route('POST', '/api/apps/:id/open', async (req, url, p, body) => ({ message: await openApp(db, getCfg(), p.id,
    { kind: 'interactive', key: 'owner:dashboard', role: 'owner', sessionId: null, runId: null }, { file: body.file || null, wait: false, claimLock: false }) }));

  route('GET', '/api/runs', (req, url) => {
    const cfg = getCfg();
    const q = Object.fromEntries(url.searchParams);
    const where = ['1=1'];
    const args = [];
    if (q.role) { where.push('r.role = ?'); args.push(q.role); }
    if (q.status) { where.push('r.status = ?'); args.push(q.status); }
    if (q.kind) { where.push('r.kind = ?'); args.push(q.kind); }
    const rows = db.prepare(`SELECT r.id, r.kind, r.role, r.status, r.purpose, r.model, r.started_at, r.ended_at, r.idea_id, r.loop_id,
        r.input_tokens + r.output_tokens + r.cache_write AS tokens, r.cost_usd, r.rating, i.title AS idea_title
      FROM runs r LEFT JOIN ideas i ON i.id = r.idea_id WHERE ${where.join(' AND ')} ORDER BY r.started_at DESC LIMIT ?`)
      .all(...args, Math.min(Number(q.limit) || 100, 500));
    return rows.map((r) => ({ ...r, roleName: roleName(cfg, r.role), live: runner.isActive(r.id) }));
  });
  route('GET', '/api/runs/:id', (req, url, p) => {
    const cfg = getCfg();
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(p.id);
    if (!run) throw new HttpError(404, 'run not found');
    return { ...run, roleName: roleName(cfg, run.role), live: runner.isActive(run.id), redoReasons: REDO_REASONS,
      activity: db.prepare('SELECT * FROM activity WHERE run_id = ? ORDER BY id DESC LIMIT 300').all(run.id).reverse() };
  });
  route('POST', '/api/runs/:id/stop', (req, url, p) => ({ stopped: runner.stop(p.id) }));
  route('POST', '/api/runs/:id/rate', (req, url, p, body) => {
    const r = rate(db, getCfg(), { runId: p.id, verdict: body.verdict, reason: body.reason, note: body.note });
    if (r.bumped) notify('Model routing changed', `${r.bumped.taskType}: ${r.bumped.from} → ${r.bumped.to} after your redo reviews`);
    return r;
  });

  route('POST', '/api/questions/:id/answer', (req, url, p, body) => {
    if (!String(body.answer || '').trim()) throw new HttpError(400, 'answer is required');
    return runner.answer(Number(p.id), String(body.answer).trim());
  });

  route('GET', '/api/activity', (req, url) => {
    const cfg = getCfg();
    const limit = Math.min(Number(url.searchParams.get('limit')) || 80, 400);
    return db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit).map((a) => ({ ...a, roleName: roleName(cfg, a.role) }));
  });

  route('GET', '/api/models', () => {
    const cfg = getCfg();
    const since = weekAgo();
    const billable = 'input_tokens + output_tokens + cache_write';
    const shipped = db.prepare('SELECT COUNT(*) n FROM ideas WHERE shipped_at >= ?').get(since).n;
    const week = db.prepare(`SELECT COALESCE(SUM(${billable}),0) t, COALESCE(SUM(cost_usd),0) c FROM runs WHERE started_at >= ?`).get(since);
    const prevWeek = db.prepare(`SELECT COALESCE(SUM(${billable}),0) t FROM runs WHERE started_at >= ? AND started_at < ?`)
      .get(new Date(Date.now() - 14 * 86400_000).toISOString(), since).t;
    const rated = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN rating = 'redo' THEN 1 ELSE 0 END) r FROM runs WHERE rating IS NOT NULL AND started_at >= ?").get(since);
    const spenders = db.prepare(`SELECT role, SUM(${billable}) t FROM runs WHERE started_at >= ? GROUP BY role ORDER BY t DESC LIMIT 5`).all(since)
      .map((s) => ({ ...s, roleName: roleName(cfg, s.role) }));
    return { routing: routingTable(db, cfg), redoReasons: REDO_REASONS,
      tokens: { today: tokensUsedSince(db, startOfToday()), week: week.t, prevWeek, costWeek: week.c, perShipped: shipped ? Math.round(week.t / shipped) : null,
        shipped, redoRate: rated.n ? rated.r / rated.n : null, spenders } };
  });
  route('POST', '/api/models/:taskType/reset', (req, url, p) => {
    db.prepare('DELETE FROM routing_overrides WHERE task_type = ?').run(p.taskType);
    db.prepare("UPDATE improvements SET status = 'reverted' WHERE kind = 'routing' AND title LIKE ? AND status = 'applied'").run(`${p.taskType}:%`);
    return { ok: true };
  });

  route('GET', '/api/improvements', () => db.prepare('SELECT * FROM improvements ORDER BY id DESC LIMIT 200').all()
    .map((i) => ({ ...i, files: i.files ? JSON.parse(i.files) : [] })));
  route('POST', '/api/improvements/:id/revert', (req, url, p) => {
    const imp = db.prepare('SELECT * FROM improvements WHERE id = ?').get(Number(p.id));
    if (!imp) throw new HttpError(404, 'improvement not found');
    if (imp.status === 'reverted') throw new HttpError(409, 'already reverted');
    if (imp.kind === 'routing' && !imp.commit_sha) {
      db.prepare('DELETE FROM routing_overrides WHERE improvement_id = ?').run(imp.id);
    } else if (imp.commit_sha) {
      const r = spawnSync('git', ['revert', '--no-edit', imp.commit_sha], { cwd: REPO_ROOT, encoding: 'utf8', env: gitEnv(getCfg()) });
      if (r.status !== 0) throw new HttpError(409, `git revert failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    } else {
      throw new HttpError(409, 'nothing to revert automatically (no commit recorded)');
    }
    db.prepare("UPDATE improvements SET status = 'reverted' WHERE id = ?").run(imp.id);
    logActivity(db, { role: 'owner', kind: 'note', summary: `reverted improvement #${imp.id}: ${imp.title}` });
    return { ok: true };
  });

  route('POST', '/api/settings', (req, url, p, body) => {
    if (body.paused !== undefined) kvSet(db, 'paused', body.paused ? '1' : '0');
    return { paused: isPaused(db) };
  });

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (!allowedHosts.has(req.headers.host || '')) return json(res, 403, { error: 'bad host' });
    if (url.pathname === '/api/events') return sse(req, res);
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return json(res, 403, { error: 'bad origin' });
      if (req.headers['x-factory-token'] !== secret) return json(res, 403, { error: 'missing or wrong token' });
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      try {
        const body = req.method === 'GET' ? {} : await readBody(req);
        return json(res, 200, await r.fn(req, url, m.groups || {}, body));
      } catch (err) {
        return json(res, err.code && Number.isInteger(err.code) ? err.code : 400, { error: err.message });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  function serveStatic(pathname, res) {
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = path.join(UI_DIR, file);
    if (!full.startsWith(UI_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    let body = fs.readFileSync(full);
    if (file === 'index.html') body = body.toString('utf8').replace('__FACTORY_TOKEN__', secret);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(body);
  }

  function sse(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    let last = changeSeq(db);
    res.write(`event: hello\ndata: ${last}\n\n`);
    let quiet = 0;
    const t = setInterval(() => {
      const seq = changeSeq(db);
      if (seq !== last) { last = seq; quiet = 0; res.write(`event: change\ndata: ${seq}\n\n`); } else if ((quiet += 1) % 15 === 0) res.write(': ping\n\n');
    }, 1000);
    req.on('close', () => clearInterval(t));
  }

  return http.createServer((req, res) => { handle(req, res).catch((err) => json(res, 500, { error: err.message })); });
}

export function gitEnv(cfg) {
  const a = cfg.settings.gitAuthor;
  return a?.name ? { ...process.env, GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_COMMITTER_NAME: a.name, GIT_COMMITTER_EMAIL: a.email } : process.env;
}
