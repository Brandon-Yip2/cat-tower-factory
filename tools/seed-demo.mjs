#!/usr/bin/env node
// Fill a scratch Factory DB with realistic demo data for looking at the dashboard.
// Usage: FACTORY_DB=<scratch>/demo.db node factory/tools/seed-demo.mjs
// The demo DB is paused and its loops are off, so a daemon pointed at it never starts real runs.
import { openDb, kvSet, now } from '../lib/db.mjs';
import { loadConfig } from '../lib/config.mjs';
import { DB_PATH } from '../lib/paths.mjs';
import { createIdea, updateIdea } from '../lib/ideas.mjs';
import { askOwner } from '../lib/questions.mjs';
import { claim, claimFiles } from '../lib/resources.mjs';
import { setEnabled } from '../lib/scheduler.mjs';

if (!process.env.FACTORY_DB) { console.error('Set FACTORY_DB to a scratch path; refusing to seed the real database.'); process.exit(1); }
const db = openDb(DB_PATH);
const cfg = loadConfig();
kvSet(db, 'paused', '1');
for (const l of cfg.loops) setEnabled(db, l.id, false);
setEnabled(db, 'nightly-qa', true);
setEnabled(db, 'morning-triage', true);
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

function run(id, role, opts = {}) {
  db.prepare(`INSERT INTO runs (id, kind, role, idea_id, status, purpose, model, model_why, task_type, started_at, ended_at, last_activity_at,
      input_tokens, output_tokens, cache_write, cache_read, cost_usd, progress, progress_note, result_text, rating, redo_reason, session_id)
    VALUES (@id, @kind, @role, @idea, @status, @purpose, @model, @why, @tt, @start, @end, @start, @in, @out, @cw, @cr, @cost, @progress, @note, @result, @rating, @redo, @sid)`)
    .run({ id, kind: opts.kind || 'factory', role, idea: opts.idea || null, status: opts.status || 'done', purpose: opts.purpose || '', model: opts.model === undefined ? 'sonnet' : opts.model,
      why: opts.why || 'config', tt: opts.tt || null, start: ago(opts.startMin ?? 30), end: opts.status === 'running' || opts.status === 'parked' ? null : ago(opts.endMin ?? 5),
      in: 900, out: opts.out ?? 22000, cw: opts.cw ?? 180000, cr: 900000, cost: opts.cost ?? 0.9, progress: opts.progress ?? null, note: opts.note || null,
      result: opts.result || null, rating: opts.rating || null, redo: opts.redo || null, sid: `${id}-session` });
}
function act(runId, role, summary, min, tool = null, kind = 'tool') {
  db.prepare('INSERT INTO activity (ts, run_id, role, kind, tool_name, summary) VALUES (?, ?, ?, ?, ?, ?)').run(ago(min), runId, role, kind, tool, summary);
}

const bonus = createIdea(db, cfg, { title: 'Daily fish bonus for the first login', origin: 'owner', area: 'Economy', kind: 'feature' });
const snap = createIdea(db, cfg, { title: 'Old Gnaw telegraphs his snap with a ground shadow', origin: 'qa', originRole: 'qa-lead', kind: 'bug', area: 'Combat' });
const book = createIdea(db, cfg, { title: 'Collection Book v2: creature lore pages', origin: 'owner', area: 'Systems' });
const canopy = createIdea(db, cfg, { title: 'Canopy respawn lands inside the trunk', origin: 'qa', originRole: 'qa-lead', kind: 'bug', area: 'World' });
const raid = createIdea(db, cfg, { title: 'Endgame: weekly Great Tree raid mode', origin: 'loop', originRole: 'design-lead', kind: 'feature', area: 'Progression',
  description: 'A weekly co-op raid up the Great Tree with a new boss at the crown.' });
const glow = createIdea(db, cfg, { title: 'Seedlight glows brighter at night', origin: 'agent', originRole: 'art-director', kind: 'polish', area: 'Art', parentId: book.id });
createIdea(db, cfg, { title: 'Floor 3 vertical race', origin: 'owner', area: 'Quests & Story' });
const steps = createIdea(db, cfg, { title: 'Creature footsteps', origin: 'owner', area: 'Audio' });
const claws = createIdea(db, cfg, { title: 'NEW CLAWS sting', origin: 'owner', area: 'Audio' });

updateIdea(db, cfg, snap.id, { status: 'building', owner_role: 'engineering-lead', task_type: 'luau-server' }, 'game-manager');
updateIdea(db, cfg, book.id, { status: 'building', owner_role: 'engineering-lead', task_type: 'luau-client' }, 'game-manager');
updateIdea(db, cfg, canopy.id, { status: 'qa', owner_role: 'engineering-lead' }, 'game-manager');
updateIdea(db, cfg, raid.id, { status: 'triaged', approval_reason: 'A whole new mode nobody asked for.' }, 'game-manager');
updateIdea(db, cfg, glow.id, { status: 'triaged', owner_role: 'art-director', task_type: 'blender-mesh' }, 'game-manager');
for (const i of [steps, claws]) {
  updateIdea(db, cfg, i.id, { status: 'building', owner_role: 'audio-director', task_type: 'audio' });
  updateIdea(db, cfg, i.id, { status: 'qa' });
  updateIdea(db, cfg, i.id, { status: 'shipped', summary: 'Shipped with the Pass 5b audio batch.' }, 'qa-lead');
}

run('f-qa1', 'qa-lead', { idea: canopy.id, status: 'running', purpose: `QA #${canopy.id}: Canopy respawn`, startMin: 12, progress: 44, note: 'Play test step 4 of 9: respawning at the canopy hub', tt: 'qa-playtest' });
run('f-bal1', 'balance-lead', { status: 'running', purpose: 'Config-pass6: Old Gnaw numbers', startMin: 31, progress: 70, note: 'Checking clear-to-death at level 6' });
run('f-eng1', 'engineering-lead', { idea: snap.id, status: 'parked', purpose: `Build #${snap.id}: Old Gnaw snap`, startMin: 20, tt: 'luau-server' });
run('f-art1', 'art-director', { idea: glow.id, purpose: 'Seedlight textures', model: 'sonnet', tt: 'blender-mesh', rating: 'redo', redo: 'model', startMin: 300, endMin: 260 });
run('f-aud1', 'audio-director', { idea: steps.id, purpose: 'Creature footsteps', tt: 'audio', rating: 'good', startMin: 2000, endMin: 1900 });
run('i-owner', 'owner-session', { kind: 'interactive', status: 'running', purpose: 'Interactive Claude Code session', startMin: 8, model: null });
claim(db, cfg, 'studio', { key: 'run:f-qa1', runId: 'f-qa1', role: 'qa-lead', reason: 'Play test for the canopy respawn fix', ideaId: canopy.id });
claim(db, cfg, 'studio', { key: 'run:f-art2', runId: 'f-art2', role: 'art-director', reason: 'Import PropSeedlight' });
claim(db, cfg, 'blender', { key: 'run:f-art3', runId: 'f-art3', role: 'art-director', reason: 'Old Gnaw claw mesh fix' });
claimFiles(db, { key: 'run:f-bal1', runId: 'f-bal1', role: 'balance-lead' }, ['place/scripts/ReplicatedStorage/Config.luau'], 'Gnaw HP and damage');
askOwner(db, { runId: 'f-eng1', role: 'engineering-lead', ideaId: snap.id }, { question: 'Old Gnaw snap: 0.6 s or 0.9 s telegraph? Shorter feels fair on PC but harsh on phone.', choices: ['0.9 s', '0.6 s'] });
act('f-qa1', 'qa-lead', 'start_stop_play mode=start', 11, 'mcp__Roblox_Studio__start_stop_play');
act('f-qa1', 'qa-lead', 'claimed studio', 11, 'mcp__Roblox_Studio__start_stop_play', 'gate');
act('f-bal1', 'balance-lead', 'place/scripts/ReplicatedStorage/Config.luau', 3, 'Edit', 'file');
act(null, 'art-director', 'denied Roblox Studio: held by Head of QA', 2, 'mcp__Roblox_Studio__execute_luau', 'gate');
db.prepare(`INSERT INTO improvements (ts, kind, title, why, evidence, files, status, actor) VALUES (?, 'instructions', ?, ?, '', ?, 'applied', 'factory-engineer')`)
  .run(now(), 'Learned rule: return Studio to Edit before releasing it', '3 runs this week found Studio left in Play mode by the previous holder and lost 20+ minutes.', JSON.stringify(['CLAUDE.md']));
console.log(`Seeded demo data into ${DB_PATH} (paused, most loops off).`);
