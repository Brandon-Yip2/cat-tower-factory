import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdea, updateIdea, getIdea, ideaOverview, ensureStandingIdea, decideApproval } from '../lib/ideas.mjs';
import { proposePass, approvePass } from '../lib/proposals.mjs';
import { dispatchTick } from '../lib/dispatcher.mjs';
import { readBible } from '../lib/bible.mjs';
import { fixture } from './helpers.mjs';

function fakeRunner(db) {
  const active = new Set();
  const started = [];
  let n = 0;
  return {
    started,
    activeCount: () => active.size,
    isActive: (id) => active.has(id),
    start(opts) {
      n += 1;
      const id = `f-${n}`;
      db.prepare(`INSERT INTO runs (id, kind, role, idea_id, session_id, status, purpose, prompt, started_at)
        VALUES (?, 'factory', ?, ?, ?, 'running', ?, ?, ?)`).run(id, opts.role, opts.ideaId || null, `s-${n}`, opts.purpose, opts.prompt, new Date().toISOString());
      active.add(id);
      started.push({ id, ...opts });
      return id;
    },
    resumeWith() { return 'r'; },
  };
}

test("the owner's idea is high level and active; tasks under it are approved and never the idea itself is dispatched", () => {
  const { db, cfg } = fixture();
  const idea = createIdea(db, cfg, { title: 'Make the first boss fight more exciting', origin: 'owner', level: 'idea' });
  assert.equal(idea.status, 'active');
  assert.throws(() => updateIdea(db, cfg, idea.id, { status: 'building' }, 'engineering-lead'), /high-level idea/);
  const task = createIdea(db, cfg, { title: 'Old Gnaw snap telegraph', origin: 'agent', parentId: idea.id, kind: 'feature' });
  assert.equal(task.approval, 'approved', 'a task under an owner idea needs no approval');
  updateIdea(db, cfg, task.id, { status: 'triaged', owner_role: 'engineering-lead' }, 'game-manager');
  const runner = fakeRunner(db);
  cfg.guards.planning = { enabled: false };
  dispatchTick(db, cfg, runner);
  assert.deepEqual(runner.started.map((s) => s.ideaId), [task.id]);
  const detail = getIdea(db, idea.id);
  assert.equal(detail.children[0].id, task.id);
  const [over] = ideaOverview(db, cfg, { statuses: ['active'] });
  assert.equal(over.taskCount, 1);
  assert.deepEqual(over.workingRoles, ['engineering-lead']);
});

test('an agent cannot create an approved high-level idea; it needs the owner', () => {
  const { db, cfg } = fixture();
  const idea = createIdea(db, cfg, { title: 'Weekly raid', origin: 'agent', level: 'idea', kind: 'bug' });
  assert.equal(idea.status, 'needs_approval');
  assert.equal(decideApproval(db, cfg, idea.id, true).status, 'active');
});

test('an approved pass becomes one plain-language idea with its tasks under it', () => {
  const { db, cfg } = fixture();
  const id = proposePass(db, cfg, { role: 'game-manager' }, { title: 'Charms you can feel', why: 'Charms change your powers.',
    tasks: [{ title: 'Charm VFX', owner_role: 'art-director', task_type: 'blender-mesh' }, { title: 'Charm numbers', owner_role: 'balance-lead', task_type: 'balance-config' }] });
  const r = approvePass(db, cfg, id, '');
  const idea = getIdea(db, r.idea);
  assert.equal(idea.level, 'idea');
  assert.equal(idea.status, 'active');
  assert.equal(idea.description, 'Charms change your powers.');
  assert.deepEqual(idea.children.map((c) => c.id), r.approved);
});

test('an active idea with no tasks makes the Game Manager break it down quickly', () => {
  const { db, cfg } = fixture();
  createIdea(db, cfg, { title: 'A magical medieval look for all menus', origin: 'owner', level: 'idea' });
  const runner = fakeRunner(db);
  dispatchTick(db, cfg, runner);
  assert.equal(runner.started[0].purpose, 'Plan the next work');
  assert.match(runner.started[0].prompt, /#1 "A magical medieval look for all menus"/);
});

test('finishing an idea queues a Game Bible update; standing ideas never close themselves', () => {
  const { db, cfg } = fixture();
  const fixes = ensureStandingIdea(db, cfg, 'fixes');
  assert.equal(ensureStandingIdea(db, cfg, 'fixes'), fixes);
  const idea = createIdea(db, cfg, { title: 'Cat combat kit', origin: 'owner', level: 'idea' });
  updateIdea(db, cfg, idea.id, { status: 'shipped', note: 'all tasks done' }, 'game-manager');
  const bible = db.prepare("SELECT * FROM ideas WHERE title = 'Game Bible' AND level = 'idea'").get();
  assert.ok(bible && bible.standing === 1);
  const task = db.prepare('SELECT * FROM ideas WHERE parent_id = ?').get(bible.id);
  assert.match(task.title, /Update the Game Bible: Cat combat kit/);
  assert.equal(task.owner_role, 'design-lead');
  assert.equal(task.status, 'triaged');
});

test('the Bible reads sections in order, keeps the changelog apart and expands includes', () => {
  const b = readBible();
  assert.equal(b.sections[0].title, 'Overview');
  assert.ok(b.sections.every((s) => s.id !== 'changelog'));
  assert.equal(b.changelog.title, 'Changelog');
  const data = b.sections.find((s) => s.id === 'game-data');
  assert.match(data.markdown, /Creatures and bosses/, 'docs/content/enemies.md is pulled in');
  assert.doesNotMatch(data.markdown, /<!-- include:/);
});
