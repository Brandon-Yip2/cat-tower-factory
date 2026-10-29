// Which model runs which kind of task, why, and how the owner's "redo" reviews move it.
import { now, logActivity } from './db.mjs';
import { roleById } from './config.mjs';
import { updateIdea, addIdeaEvent, getIdeaRow } from './ideas.mjs';

export const REDO_REASONS = {
  model: 'Model wasn\'t strong enough',
  spec: 'Spec was wrong',
  instructions: 'Didn\'t follow instructions',
  cost: 'Too slow / too many tokens',
};

export function modelFor(db, cfg, { role, taskType }) {
  if (taskType) {
    const o = db.prepare('SELECT * FROM routing_overrides WHERE task_type = ?').get(taskType);
    if (o) return { model: o.model, why: o.why, source: 'learned' };
    const r = cfg.routing[taskType];
    if (r) return { model: r.model, why: r.why, source: 'config' };
  }
  const rd = roleById(cfg, role);
  return { model: rd?.defaultModel || 'sonnet', why: `${rd?.name || role} default`, source: 'role' };
}

export function routingTable(db, cfg) {
  const stats = db.prepare(`SELECT task_type, model, COUNT(*) runs,
      SUM(CASE WHEN rating = 'redo' THEN 1 ELSE 0 END) redo,
      SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) rated,
      AVG(input_tokens + output_tokens + cache_write) avg_tokens
    FROM runs WHERE kind = 'factory' AND task_type IS NOT NULL GROUP BY task_type, model`).all();
  return Object.keys(cfg.routing).map((taskType) => {
    const cur = modelFor(db, cfg, { taskType });
    return { taskType, ...cur, configModel: cfg.routing[taskType].model, evidence: stats.filter((s) => s.task_type === taskType) };
  });
}

// The run that built an idea: the latest non-QA factory run for it.
function buildRunFor(db, ideaId) {
  return db.prepare(`SELECT * FROM runs WHERE idea_id = ? AND kind = 'factory' AND role != 'qa-lead'
    ORDER BY started_at DESC LIMIT 1`).get(ideaId);
}

// verdict: 'good' | 'redo'. Redo on an idea sends it back to building with the note.
export function rate(db, cfg, { runId = null, ideaId = null, verdict, reason = null, note = '' }) {
  if (!['good', 'redo'].includes(verdict)) throw new Error('verdict must be good or redo');
  if (verdict === 'redo' && reason && !REDO_REASONS[reason]) throw new Error(`reason must be one of ${Object.keys(REDO_REASONS).join(', ')}`);
  let run = runId ? db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) : null;
  if (!run && ideaId) run = buildRunFor(db, ideaId);
  const idea = ideaId ? getIdeaRow(db, ideaId) : run?.idea_id ? getIdeaRow(db, run.idea_id) : null;
  if (run) {
    db.prepare('UPDATE runs SET rating = ?, redo_reason = ?, rating_note = ? WHERE id = ?')
      .run(verdict, verdict === 'redo' ? reason : null, note || null, run.id);
  }
  if (idea) {
    db.prepare('UPDATE ideas SET rating = ?, rating_note = ?, updated_at = ? WHERE id = ?').run(verdict, note || null, now(), idea.id);
    addIdeaEvent(db, idea.id, 'owner', 'rating', verdict === 'good' ? `👍 good${note ? `: ${note}` : ''}` : `↺ redo (${REDO_REASONS[reason] || 'no reason'})${note ? `: ${note}` : ''}`);
    if (verdict === 'redo' && ['shipped', 'qa', 'on_hold'].includes(idea.status)) {
      if (idea.status !== 'qa') db.prepare('UPDATE ideas SET rework_count = rework_count + 1 WHERE id = ?').run(idea.id);
      updateIdea(db, cfg, idea.id, { status: 'building', note: `Owner asked for a redo: ${REDO_REASONS[reason] || ''} ${note}`.trim() }, 'owner');
    }
  }
  const bumped = verdict === 'redo' && reason === 'model' && run?.task_type ? maybeBump(db, cfg, run.task_type, run.model) : null;
  return { runId: run?.id || null, ideaId: idea?.id || null, bumped };
}

// Learning rule: enough "model too weak" redos in the recent window → one tier up.
export function maybeBump(db, cfg, taskType, model) {
  const { window, modelRedosToBump, tiers } = cfg.guards.learning;
  const recent = db.prepare(`SELECT rating, redo_reason FROM runs WHERE task_type = ? AND model = ? AND rating IS NOT NULL
    ORDER BY started_at DESC LIMIT ?`).all(taskType, model, window);
  const weak = recent.filter((r) => r.rating === 'redo' && r.redo_reason === 'model').length;
  const idx = tiers.indexOf(model);
  if (weak < modelRedosToBump || idx < 0 || idx >= tiers.length - 1) return null;
  const to = tiers[idx + 1];
  const why = `Owner marked ${weak} of the last ${recent.length} rated ${taskType} runs on ${model} as "model wasn't strong enough".`;
  const info = db.prepare(`INSERT INTO improvements (ts, kind, title, why, evidence, status, actor)
    VALUES (?, 'routing', ?, ?, ?, 'applied', 'factory')`)
    .run(now(), `${taskType}: ${model} → ${to}`, why, JSON.stringify(recent));
  db.prepare(`INSERT INTO routing_overrides (task_type, model, why, source, created_at, improvement_id)
    VALUES (?, ?, ?, 'learned', ?, ?) ON CONFLICT(task_type) DO UPDATE SET model = excluded.model, why = excluded.why,
    source = excluded.source, created_at = excluded.created_at, improvement_id = excluded.improvement_id`)
    .run(taskType, to, why, now(), Number(info.lastInsertRowid));
  logActivity(db, { role: 'factory', kind: 'note', summary: `routing: ${taskType} moved ${model} → ${to}` });
  return { taskType, from: model, to, improvementId: Number(info.lastInsertRowid) };
}
