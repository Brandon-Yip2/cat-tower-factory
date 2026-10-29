// Moves approved ideas through the pipeline by starting (or resuming) the right agent,
// within the guards: pause switch, daily token budget, concurrency, per-idea limits, backoff.
import { kvGet, tokensUsedSince, startOfToday, logActivity } from './db.mjs';
import { updateIdea, addIdeaEvent } from './ideas.mjs';
import { roleById } from './config.mjs';
import { askOwner, sendMessage } from './questions.mjs';
import { triagePrompt, specPrompt, buildPrompt, qaPrompt } from './stages.mjs';

const APPROVED = new Set(['approved', 'owner_approved']);
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

export function budgetState(db, cfg) {
  const used = tokensUsedSince(db, startOfToday());
  const limit = cfg.guards.dailyTokenBudget;
  return { used, limit, exhausted: used >= limit };
}

export const isPaused = (db) => kvGet(db, 'paused', '0') === '1';

function stageFor(idea) {
  if (idea.status === 'triaged') return idea.needs_spec ? 'spec' : 'building';
  if (['spec', 'building', 'qa'].includes(idea.status)) return idea.status;
  return null;
}

function roleForStage(cfg, idea, stage) {
  if (stage === 'spec') return 'design-lead';
  if (stage === 'qa') return 'qa-lead';
  const owner = idea.owner_role && roleById(cfg, idea.owner_role);
  return owner && owner.builds !== false ? owner.id : 'engineering-lead';
}

function hold(db, cfg, idea, reason) {
  updateIdea(db, cfg, idea.id, { status: 'on_hold', note: reason }, 'factory');
  askOwner(db, { role: 'game-manager', ideaId: idea.id }, {
    question: `Idea #${idea.id} "${idea.title}" was put on hold: ${reason} What should happen next?`,
    choices: ['Try again', 'Reject it'], blocking: false, ideaId: idea.id, kind: 'hold',
  });
}

function triageTick(db, cfg, runner) {
  const active = db.prepare("SELECT id FROM runs WHERE status = 'running' AND purpose LIKE 'Triage%'").all().some((r) => runner.isActive(r.id));
  if (active) return 0;
  const inbox = db.prepare("SELECT * FROM ideas WHERE status = 'inbox' ORDER BY priority, created_at").all();
  const batch = [];
  for (const idea of inbox) {
    const tries = db.prepare("SELECT COUNT(*) n FROM idea_events WHERE idea_id = ? AND kind = 'triage'").get(idea.id).n;
    if (tries >= 2) { hold(db, cfg, idea, 'triage did not move it after two tries.'); continue; }
    batch.push(idea);
    if (batch.length >= cfg.settings.triageBatch) break;
  }
  if (!batch.length) return 0;
  for (const i of batch) addIdeaEvent(db, i.id, 'factory', 'triage', 'sent to triage');
  runner.start({ role: 'game-manager', purpose: `Triage ${batch.length} idea(s)`, prompt: triagePrompt(batch, cfg), taskType: 'triage' });
  return 1;
}

// Last run for this idea, and how many runs in a row ended without moving the idea.
function ideaHistory(db, ideaId) {
  const runs = db.prepare("SELECT * FROM runs WHERE idea_id = ? AND kind = 'factory' ORDER BY started_at DESC").all(ideaId);
  // Limits count only runs since the owner last reset the idea (taking it off hold).
  const reset = db.prepare("SELECT ts FROM idea_events WHERE idea_id = ? AND kind = 'reset' ORDER BY id DESC LIMIT 1").get(ideaId);
  const counted = reset ? runs.filter((r) => Date.parse(r.started_at) >= Date.parse(reset.ts)) : runs;
  const events = db.prepare("SELECT ts FROM idea_events WHERE idea_id = ? AND kind = 'status' ORDER BY id DESC LIMIT 1").get(ideaId);
  const lastMove = events ? Date.parse(events.ts) : 0;
  let stalled = 0;
  for (const r of counted) { if (Date.parse(r.started_at) >= lastMove && r.status !== 'running') stalled += 1; else break; }
  return { runs, counted, last: counted[0] || null, stalled };
}

export function dispatchTick(db, cfg, runner, at = Date.now()) {
  if (isPaused(db) || budgetState(db, cfg).exhausted) return { started: 0, reason: isPaused(db) ? 'paused' : 'budget' };
  let slots = cfg.guards.maxConcurrentRuns - runner.activeCount();
  let started = 0;
  if (slots > 0 && triageTick(db, cfg, runner)) { slots -= 1; started += 1; }
  if (slots <= 0) return { started };

  const ideas = db.prepare(`SELECT * FROM ideas WHERE status IN ('triaged','spec','building','qa')
    ORDER BY priority, updated_at`).all();
  for (const idea of ideas) {
    if (slots <= 0) break;
    if (!APPROVED.has(idea.approval)) continue;
    const stage = stageFor(idea);
    if (!stage) continue;
    const h = ideaHistory(db, idea.id);
    if (h.runs.some((r) => runner.isActive(r.id) || r.status === 'parked')) continue;
    if (db.prepare("SELECT COUNT(*) n FROM questions WHERE idea_id = ? AND status = 'open' AND kind != 'approval'").get(idea.id).n) continue;
    if (h.last && ['failed', 'stopped'].includes(h.last.status)) continue; // the owner decides (Retry / Resume)
    if (h.counted.length >= cfg.guards.maxRunsPerIdea) { hold(db, cfg, idea, `it used ${h.counted.length} runs without shipping.`); continue; }
    if (idea.rework_count > cfg.guards.maxRework) { hold(db, cfg, idea, `QA sent it back ${idea.rework_count} times.`); continue; }
    if (h.stalled && h.last?.ended_at) {
      const wait = Math.min(BACKOFF_BASE_MS * 2 ** (h.stalled - 1), BACKOFF_MAX_MS);
      if (at - Date.parse(h.last.ended_at) < wait) continue;
    }

    const role = roleForStage(cfg, idea, stage);
    if (idea.status === 'triaged') updateIdea(db, cfg, idea.id, { status: stage, note: `dispatched to ${role}` }, 'factory');
    const fresh = db.prepare('SELECT * FROM ideas WHERE id = ?').get(idea.id);
    const last = h.last;
    if (h.stalled && last?.role === role && last.session_id && last.status === 'done') {
      // Same agent, same stage, nothing moved: continue its session rather than starting cold.
      const msgId = sendMessage(db, { from: 'factory', to: role, runId: last.id, kind: 'note',
        text: `The Factory is resuming you: idea #${idea.id} is still in "${fresh.status}". Check factory_status (tools may be free now) and continue; move the idea with update_idea when your stage is done.` });
      runner.resumeWith(last.id, [db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId)], { ownerAction: false });
    } else {
      const prompt = stage === 'spec' ? specPrompt(fresh) : stage === 'qa' ? qaPrompt(fresh) : buildPrompt(fresh);
      const label = stage === 'spec' ? 'Spec' : stage === 'qa' ? 'QA' : 'Build';
      runner.start({ role, purpose: `${label} #${idea.id}: ${idea.title}`.slice(0, 120), prompt, ideaId: idea.id,
        taskType: stage === 'qa' ? 'qa-playtest' : stage === 'spec' ? 'spec-design' : (fresh.task_type || undefined) });
    }
    logActivity(db, { role: 'factory', kind: 'status', summary: `dispatched #${idea.id} (${stage}) to ${role}` });
    slots -= 1;
    started += 1;
  }
  return { started };
}
