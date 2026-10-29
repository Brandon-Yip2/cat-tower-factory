// Pass proposals: the Game Manager bundles tasks for several roles into a pass; the owner approves
// it (optionally with additions) or denies it. Approved tasks become backlog ideas that agents pick up.
import { now, logActivity } from './db.mjs';
import { roleById } from './config.mjs';
import { createIdea, updateIdea, getIdeaRow, addIdeaEvent, KINDS } from './ideas.mjs';
import { sendMessage } from './questions.mjs';

// task: { title, description, owner_role, task_type, area?, kind?, priority?, after?: [task index], after_ideas?: [idea id], idea_id? }
export function validateTasks(db, cfg, tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('a pass needs at least one task');
  if (tasks.length > 15) throw new Error('keep a pass to 15 tasks or fewer');
  tasks.forEach((t, i) => {
    const where = `task ${i + 1}`;
    if (t.idea_id) {
      if (!getIdeaRow(db, t.idea_id)) throw new Error(`${where}: idea #${t.idea_id} does not exist`);
    } else if (!String(t.title || '').trim()) throw new Error(`${where}: title is required`);
    const role = roleById(cfg, t.owner_role);
    if (!role || role.builds === false) throw new Error(`${where}: owner_role must be one of ${cfg.roles.filter((r) => r.builds !== false).map((r) => r.id).join(', ')}`);
    if (t.task_type && (!cfg.routing[t.task_type] || t.task_type === 'triage')) throw new Error(`${where}: unknown task_type "${t.task_type}"`);
    if (t.kind && !KINDS.includes(t.kind)) throw new Error(`${where}: kind must be one of ${KINDS.join(', ')}`);
    for (const a of t.after || []) if (!Number.isInteger(a) || a < 1 || a > tasks.length || a === i + 1) throw new Error(`${where}: "after" must list other task numbers in this pass (1-${tasks.length})`);
    for (const d of t.after_ideas || []) if (!getIdeaRow(db, d)) throw new Error(`${where}: after_ideas #${d} does not exist`);
  });
  return tasks;
}

export function proposePass(db, cfg, who, { title, why, tasks }) {
  if (!String(title || '').trim()) throw new Error('title is required');
  validateTasks(db, cfg, tasks);
  const pending = db.prepare("SELECT id FROM proposals WHERE status = 'pending'").get();
  if (pending) throw new Error(`proposal #${pending.id} is still waiting for the owner; improve it with revise_pass instead of adding another`);
  const info = db.prepare(`INSERT INTO proposals (title, why, tasks, status, created_by, run_id, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(String(title).slice(0, 160), String(why || ''), JSON.stringify(tasks), who.role || 'agent', who.runId || null, now());
  logActivity(db, { runId: who.runId, role: who.role, kind: 'question', summary: `proposed pass: ${title} (${tasks.length} tasks)` });
  return Number(info.lastInsertRowid);
}

export function revisePass(db, cfg, who, id, { title, why, tasks }) {
  const p = getProposal(db, id);
  if (!p || p.status !== 'pending') throw new Error(`proposal #${id} is not pending`);
  if (tasks) validateTasks(db, cfg, tasks);
  db.prepare('UPDATE proposals SET title = ?, why = ?, tasks = ? WHERE id = ?')
    .run(title || p.title, why ?? p.why, JSON.stringify(tasks || p.tasks), id);
  return id;
}

export function getProposal(db, id) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  return p ? { ...p, tasks: JSON.parse(p.tasks) } : null;
}

export function pendingProposals(db, cfg) {
  return db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id").all().map((p) => ({
    ...p,
    tasks: JSON.parse(p.tasks).map((t) => ({ ...t, roleName: roleById(cfg, t.owner_role)?.name || t.owner_role,
      title: t.title || getIdeaRow(db, t.idea_id)?.title })),
  }));
}

function nextRank(db) {
  return (db.prepare('SELECT COALESCE(MAX(rank), 0) r FROM ideas').get().r || 0) + 10;
}

// Approve: every task becomes an owner-approved backlog idea ("Up next"), in the pass's order.
export function approvePass(db, cfg, id, note = '') {
  const p = getProposal(db, id);
  if (!p || p.status !== 'pending') throw new Error(`proposal #${id} is not pending`);
  const extra = String(note || '').trim();
  const ideaIds = [];
  return db.transaction(() => {
    for (const t of p.tasks) {
      let ideaId = t.idea_id;
      const description = `${t.description || ''}${extra ? `\n\nOwner's additions when approving "${p.title}": ${extra}` : ''}`.trim();
      if (!ideaId) {
        ideaId = createIdea(db, cfg, { title: t.title, description, kind: t.kind || 'feature', area: t.area, origin: 'agent',
          originRole: p.created_by, originRunId: p.run_id, pass: p.title }).id;
      } else if (extra) {
        db.prepare('UPDATE ideas SET description = ? WHERE id = ?').run(`${getIdeaRow(db, ideaId).description}\n\n${description}`.trim(), ideaId);
      }
      ideaIds.push(ideaId);
    }
    p.tasks.forEach((t, i) => {
      const deps = [...(t.after || []).map((n) => ideaIds[n - 1]), ...(t.after_ideas || [])];
      db.prepare('UPDATE ideas SET rank = ?, pass_label = ? WHERE id = ?').run(nextRank(db), p.title, ideaIds[i]);
      updateIdea(db, cfg, ideaIds[i], {
        approval: 'owner_approved', status: 'triaged', owner_role: t.owner_role, task_type: t.task_type || null,
        area: t.area || null, kind: t.kind || 'feature', priority: t.priority || 2, needs_spec: false,
        depends_on: deps, note: `approved by the owner in pass "${p.title}"`,
      }, 'owner');
      if (extra) addIdeaEvent(db, ideaIds[i], 'owner', 'note', `Owner's additions: ${extra}`);
    });
    db.prepare("UPDATE proposals SET status = 'approved', owner_note = ?, decided_at = ?, idea_ids = ? WHERE id = ?")
      .run(extra || null, now(), JSON.stringify(ideaIds), id);
    sendMessage(db, { from: 'owner', to: p.created_by, kind: 'note',
      text: `The owner approved pass "${p.title}"${extra ? ` with these additions: ${extra}. Adjust the new ideas (${ideaIds.map((x) => `#${x}`).join(', ')}) with update_idea or add tasks with propose_idea if the additions need it.` : '.'}` });
    return { approved: ideaIds };
  }).immediate();
}

export function denyPass(db, id, reason = '') {
  const p = getProposal(db, id);
  if (!p || p.status !== 'pending') throw new Error(`proposal #${id} is not pending`);
  db.prepare("UPDATE proposals SET status = 'denied', owner_note = ?, decided_at = ? WHERE id = ?").run(reason || null, now(), id);
  sendMessage(db, { from: 'owner', to: p.created_by, kind: 'note',
    text: `The owner denied pass "${p.title}"${reason ? `: ${reason}` : ''}. Take that into account in the next pass.` });
  return { denied: id };
}
