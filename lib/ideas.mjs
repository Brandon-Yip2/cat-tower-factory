// The idea pipeline: inbox → triaged → spec → building → qa → shipped
// (+ needs_approval, on_hold, rejected), with the owner's approval rule as a hard backstop.
import { now } from './db.mjs';
import { roleById } from './config.mjs';

export const STATUSES = ['inbox', 'needs_approval', 'triaged', 'spec', 'building', 'staged', 'qa', 'shipped', 'on_hold', 'rejected'];
export const ACTIVE = ['inbox', 'needs_approval', 'triaged', 'spec', 'building', 'staged', 'qa', 'on_hold'];
export const DONE = ['shipped', 'rejected'];
export const KINDS = ['feature', 'bug', 'polish', 'tuning', 'content', 'tech'];
const PAST_TRIAGE = new Set(['spec', 'building', 'staged', 'qa', 'shipped']);
const APPROVED = new Set(['approved', 'owner_approved']);
const AGENT_FIELDS = ['title', 'description', 'area', 'kind', 'task_type', 'owner_role', 'priority', 'needs_spec',
  'spec_path', 'parent_id', 'summary', 'status', 'approval_reason', 'depends_on'];

export class ApprovalError extends Error {}

// depends_on is stored as JSON text of idea ids; accepts an array, a JSON string or null.
export function parseDeps(v) {
  if (v === null || v === undefined || v === '') return [];
  const arr = Array.isArray(v) ? v : JSON.parse(v);
  return [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

function checkDeps(db, deps, selfId = null) {
  for (const d of deps) {
    if (d === selfId) throw new Error('an idea cannot depend on itself');
    if (!db.prepare('SELECT 1 FROM ideas WHERE id = ?').get(d)) throw new Error(`depends_on: idea #${d} does not exist`);
  }
}

// Ids of dependencies that have not shipped yet.
export function unmetDeps(db, idea) {
  return parseDeps(idea.depends_on).filter((d) => db.prepare('SELECT status FROM ideas WHERE id = ?').get(d)?.status !== 'shipped');
}

// Owner ruling 2026-10-29: everything proceeds on its own except a brand-new idea an agent
// came up with itself (a feature that serves no owner idea).
export function approvalFor(idea, guards = {}) {
  if (idea.approval === 'owner_approved' || idea.approval === 'rejected') return idea.approval;
  const rules = guards.approval || {};
  if (idea.origin === 'owner' && rules.ownerIdeasAutoApproved !== false) return 'approved';
  if (rules.agentFeaturesWithoutParentNeedOwner === false) return 'approved';
  if (idea.parent_id) return 'approved'; // parent is checked to be an owner idea (checkParent)
  if (idea.approval === 'needs_owner') return 'needs_owner'; // sticky: relabelling the kind never clears it
  if ((idea.kind || 'feature') !== 'feature') return 'approved';
  return 'needs_owner';
}

// Only an idea the owner gave (or approved) can make an agent idea "serve an owner idea".
function checkParent(db, parentId, selfId = null) {
  if (parentId === null || parentId === undefined) return;
  const p = db.prepare('SELECT id, origin, approval FROM ideas WHERE id = ?').get(parentId);
  if (!p || p.id === selfId || (p.origin !== 'owner' && p.approval !== 'owner_approved')) {
    throw new ApprovalError(`parent_id #${parentId} must be an existing idea from the owner (or one the owner approved).`);
  }
}

export function addIdeaEvent(db, ideaId, actor, kind, text = '') {
  db.prepare('INSERT INTO idea_events (idea_id, ts, actor, kind, text) VALUES (?, ?, ?, ?, ?)')
    .run(ideaId, now(), actor, kind, String(text).slice(0, 2000));
}

export function createIdea(db, cfg, input) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('title is required');
  const kind = KINDS.includes(input.kind) ? input.kind : 'feature';
  if ((input.origin || 'owner') !== 'owner') checkParent(db, input.parentId);
  const deps = parseDeps(input.dependsOn);
  checkDeps(db, deps);
  const t = now();
  const draft = {
    origin: input.origin || 'owner', kind, parent_id: input.parentId || null, approval: 'pending',
  };
  const approval = approvalFor(draft, cfg.guards);
  const info = db.prepare(`INSERT INTO ideas (title, description, area, kind, task_type, origin, origin_role,
      origin_run_id, parent_id, status, approval, owner_role, priority, pass_label, depends_on, created_at, updated_at)
    VALUES (@title, @description, @area, @kind, @task_type, @origin, @origin_role, @origin_run_id, @parent_id,
      'inbox', @approval, @owner_role, @priority, @pass_label, @depends_on, @t, @t)`).run({
    depends_on: deps.length ? JSON.stringify(deps) : null,
    title,
    description: String(input.description || ''),
    area: input.area || null,
    kind,
    task_type: input.taskType || null,
    origin: draft.origin,
    origin_role: input.originRole || null,
    origin_run_id: input.originRunId || null,
    parent_id: draft.parent_id,
    approval,
    owner_role: input.ownerRole || null,
    priority: Number(input.priority) || 2,
    pass_label: input.pass || cfg.settings.currentPass || null,
    t,
  });
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE ideas SET rank = (SELECT COALESCE(MAX(rank), 0) + 10 FROM ideas) WHERE id = ?').run(id);
  const who = draft.origin === 'owner' ? 'owner' : (input.originRole || draft.origin);
  addIdeaEvent(db, id, who, 'created', `${draft.origin} idea${draft.parent_id ? ` (serves #${draft.parent_id})` : ''}`);
  return getIdeaRow(db, id);
}

export function getIdeaRow(db, id) {
  return db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) || null;
}

// Agents and the dispatcher move ideas with this. `actor` is a role id or 'owner'/'factory'.
export function updateIdea(db, cfg, id, patch, actor = 'factory') {
  const idea = getIdeaRow(db, id);
  if (!idea) throw new Error(`idea #${id} not found`);
  const next = { ...idea };
  for (const k of AGENT_FIELDS) if (patch[k] !== undefined) next[k] = patch[k];
  if (next.kind && !KINDS.includes(next.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  if (patch.owner_role !== undefined && patch.owner_role !== null) {
    const r = roleById(cfg, patch.owner_role);
    if (!r || r.builds === false) {
      const builders = cfg.roles.filter((x) => x.builds !== false).map((x) => x.id);
      throw new Error(`owner_role must be a building role: ${builders.join(', ')}`);
    }
  }
  if (patch.task_type !== undefined && patch.task_type !== null && (!cfg.routing[patch.task_type] || patch.task_type === 'triage')) {
    throw new Error(`task_type must be one of: ${Object.keys(cfg.routing).filter((t) => t !== 'triage').join(', ')}`);
  }
  if (patch.parent_id !== undefined && patch.parent_id !== idea.parent_id && idea.origin !== 'owner') checkParent(db, patch.parent_id, id);
  if (patch.depends_on !== undefined) {
    const deps = parseDeps(patch.depends_on);
    checkDeps(db, deps, id);
    next.depends_on = deps.length ? JSON.stringify(deps) : null;
  }
  if (actor === 'owner' && patch.approval) next.approval = patch.approval;
  next.approval = approvalFor(next, cfg.guards);

  if (next.status === 'triaged' && next.approval === 'needs_owner') next.status = 'needs_approval';
  if (PAST_TRIAGE.has(next.status) && !APPROVED.has(next.approval)) {
    throw new ApprovalError(`idea #${id} is a brand-new agent idea waiting for the owner's approval; `
      + 'it cannot move past triage. Set parent_id if it serves an owner idea, or leave it for the owner.');
  }
  if (idea.status === 'qa' && next.status === 'building') next.rework_count = idea.rework_count + 1;
  // Owner takes an idea off hold: give it a fresh allowance (the dispatcher counts runs since this reset).
  const ownerReset = actor === 'owner' && idea.status === 'on_hold' && !['on_hold', 'rejected'].includes(next.status);
  if (ownerReset) next.rework_count = 0;
  if (next.status === 'shipped' && idea.status !== 'shipped') next.shipped_at = now();

  db.prepare(`UPDATE ideas SET title=@title, description=@description, area=@area, kind=@kind, task_type=@task_type,
      owner_role=@owner_role, priority=@priority, needs_spec=@needs_spec, spec_path=@spec_path, parent_id=@parent_id,
      summary=@summary, status=@status, approval=@approval, approval_reason=@approval_reason, depends_on=@depends_on,
      rework_count=@rework_count, shipped_at=@shipped_at, updated_at=@updated_at WHERE id=@id`)
    .run({ ...next, needs_spec: next.needs_spec ? 1 : 0, updated_at: now() });

  if (ownerReset) addIdeaEvent(db, id, 'owner', 'reset', 'run and rework allowance reset');
  if (next.status !== idea.status) {
    addIdeaEvent(db, id, actor, 'status', `${idea.status} → ${next.status}${patch.note ? `: ${patch.note}` : ''}`);
  } else if (patch.note) {
    addIdeaEvent(db, id, actor, 'note', patch.note);
  }
  // Brand-new agent ideas wait in 'needs_approval'; the Game Manager bundles the good ones into its next
  // pass proposal, which the owner approves or denies in one go.
  return getIdeaRow(db, id);
}

// Owner decisions on approval.
export function decideApproval(db, cfg, id, approve, note = '') {
  const idea = getIdeaRow(db, id);
  if (!idea) throw new Error(`idea #${id} not found`);
  const approval = approve ? 'owner_approved' : 'rejected';
  const status = approve ? (idea.status === 'needs_approval' || idea.status === 'inbox' ? 'triaged' : idea.status) : 'rejected';
  db.prepare('UPDATE ideas SET approval = ?, status = ?, updated_at = ? WHERE id = ?').run(approval, status, now(), id);
  addIdeaEvent(db, id, 'owner', approve ? 'approved' : 'rejected', note);
  db.prepare(`UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, handled = 1
    WHERE idea_id = ? AND kind = 'approval' AND status = 'open'`).run(approve ? 'Approve' : 'Reject', now(), id);
  return getIdeaRow(db, id);
}

export function getIdea(db, id) {
  const idea = getIdeaRow(db, id);
  if (!idea) return null;
  return {
    ...idea,
    events: db.prepare('SELECT * FROM idea_events WHERE idea_id = ? ORDER BY id').all(id),
    runs: db.prepare(`SELECT id, role, model, status, purpose, started_at, ended_at, input_tokens, output_tokens,
        cache_write, cost_usd, rating, redo_reason FROM runs WHERE idea_id = ? ORDER BY started_at`).all(id),
    questions: db.prepare('SELECT * FROM questions WHERE idea_id = ? ORDER BY id').all(id),
    children: db.prepare('SELECT id, title, status FROM ideas WHERE parent_id = ?').all(id),
    parent: idea.parent_id ? db.prepare('SELECT id, title, status FROM ideas WHERE id = ?').get(idea.parent_id) : null,
    deps: parseDeps(idea.depends_on).map((d) => db.prepare('SELECT id, title, status FROM ideas WHERE id = ?').get(d)).filter(Boolean),
  };
}

export function listIdeas(db, f = {}) {
  const where = [];
  const args = {};
  if (f.status) { where.push('status = @status'); args.status = f.status; }
  if (f.stageGroup === 'active') where.push(`status IN (${ACTIVE.map((s) => `'${s}'`).join(',')})`);
  if (f.stageGroup === 'done') where.push(`status IN (${DONE.map((s) => `'${s}'`).join(',')})`);
  if (f.area) { where.push('area = @area'); args.area = f.area; }
  if (f.origin) { where.push('origin = @origin'); args.origin = f.origin; }
  if (f.ownerRole) { where.push('owner_role = @owner'); args.owner = f.ownerRole; }
  if (f.pass) { where.push('pass_label = @pass'); args.pass = f.pass; }
  if (f.q) { where.push('(title LIKE @q OR description LIKE @q)'); args.q = `%${f.q}%`; }
  const sql = `SELECT * FROM ideas ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE WHEN status IN ('shipped','rejected') THEN COALESCE(shipped_at, updated_at) END DESC,
      priority ASC, rank ASC, updated_at DESC LIMIT ${Math.min(Number(f.limit) || 500, 2000)}`;
  return db.prepare(sql).all(args);
}

export function stageCounts(db, pass = null) {
  const rows = pass
    ? db.prepare('SELECT status, COUNT(*) n FROM ideas WHERE pass_label = ? GROUP BY status').all(pass)
    : db.prepare('SELECT status, COUNT(*) n FROM ideas GROUP BY status').all();
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) out[r.status] = r.n;
  return out;
}
