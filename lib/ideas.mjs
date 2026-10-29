// The idea pipeline: inbox → triaged → spec → building → qa → shipped
// (+ needs_approval, on_hold, rejected), with the owner's approval rule as a hard backstop.
import { now } from './db.mjs';

export const STATUSES = ['inbox', 'needs_approval', 'triaged', 'spec', 'building', 'qa', 'shipped', 'on_hold', 'rejected'];
export const ACTIVE = ['inbox', 'needs_approval', 'triaged', 'spec', 'building', 'qa', 'on_hold'];
export const DONE = ['shipped', 'rejected'];
export const KINDS = ['feature', 'bug', 'polish', 'tuning', 'content', 'tech'];
const PAST_TRIAGE = new Set(['spec', 'building', 'qa', 'shipped']);
const APPROVED = new Set(['approved', 'owner_approved']);
const AGENT_FIELDS = ['title', 'description', 'area', 'kind', 'task_type', 'owner_role', 'priority', 'needs_spec',
  'spec_path', 'parent_id', 'summary', 'status', 'approval_reason'];

export class ApprovalError extends Error {}

// Owner ruling 2026-10-29: everything proceeds on its own except a brand-new idea an agent
// came up with itself (a feature that serves no owner idea).
export function approvalFor(idea, guards = {}) {
  if (idea.approval === 'owner_approved' || idea.approval === 'rejected') return idea.approval;
  const rules = guards.approval || {};
  if (idea.origin === 'owner' && rules.ownerIdeasAutoApproved !== false) return 'approved';
  if (rules.agentFeaturesWithoutParentNeedOwner === false) return 'approved';
  if (idea.parent_id) return 'approved';
  if ((idea.kind || 'feature') !== 'feature') return 'approved';
  return 'needs_owner';
}

export function addIdeaEvent(db, ideaId, actor, kind, text = '') {
  db.prepare('INSERT INTO idea_events (idea_id, ts, actor, kind, text) VALUES (?, ?, ?, ?, ?)')
    .run(ideaId, now(), actor, kind, String(text).slice(0, 2000));
}

export function createIdea(db, cfg, input) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('title is required');
  const kind = KINDS.includes(input.kind) ? input.kind : 'feature';
  const t = now();
  const draft = {
    origin: input.origin || 'owner', kind, parent_id: input.parentId || null, approval: 'pending',
  };
  const approval = approvalFor(draft, cfg.guards);
  const info = db.prepare(`INSERT INTO ideas (title, description, area, kind, task_type, origin, origin_role,
      origin_run_id, parent_id, status, approval, owner_role, priority, pass_label, created_at, updated_at)
    VALUES (@title, @description, @area, @kind, @task_type, @origin, @origin_role, @origin_run_id, @parent_id,
      'inbox', @approval, @owner_role, @priority, @pass_label, @t, @t)`).run({
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
  if (actor === 'owner' && patch.approval) next.approval = patch.approval;
  next.approval = approvalFor(next, cfg.guards);

  if (next.status === 'triaged' && next.approval === 'needs_owner') next.status = 'needs_approval';
  if (PAST_TRIAGE.has(next.status) && !APPROVED.has(next.approval)) {
    throw new ApprovalError(`idea #${id} is a brand-new agent idea waiting for the owner's approval; `
      + 'it cannot move past triage. Set parent_id if it serves an owner idea, or leave it for the owner.');
  }
  if (idea.status === 'qa' && next.status === 'building') next.rework_count = idea.rework_count + 1;
  if (next.status === 'shipped' && idea.status !== 'shipped') next.shipped_at = now();

  db.prepare(`UPDATE ideas SET title=@title, description=@description, area=@area, kind=@kind, task_type=@task_type,
      owner_role=@owner_role, priority=@priority, needs_spec=@needs_spec, spec_path=@spec_path, parent_id=@parent_id,
      summary=@summary, status=@status, approval=@approval, approval_reason=@approval_reason,
      rework_count=@rework_count, shipped_at=@shipped_at, updated_at=@updated_at WHERE id=@id`)
    .run({ ...next, needs_spec: next.needs_spec ? 1 : 0, updated_at: now() });

  if (next.status !== idea.status) {
    addIdeaEvent(db, id, actor, 'status', `${idea.status} → ${next.status}${patch.note ? `: ${patch.note}` : ''}`);
  } else if (patch.note) {
    addIdeaEvent(db, id, actor, 'note', patch.note);
  }
  if (next.status === 'needs_approval' && idea.status !== 'needs_approval') {
    db.prepare(`INSERT INTO questions (role, idea_id, kind, text, choices, blocking, created_at)
      VALUES (?, ?, 'approval', ?, ?, 0, ?)`)
      .run(next.origin_role || actor, id,
        `New idea from ${next.origin_role || next.origin}: "${next.title}". ${next.approval_reason || ''}`.trim(),
        JSON.stringify(['Approve', 'Reject']), now());
  }
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
      priority ASC, updated_at DESC LIMIT ${Math.min(Number(f.limit) || 500, 2000)}`;
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
