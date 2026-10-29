// Builds the prompts the dispatcher sends for each pipeline stage from the Markdown templates in
// factory/prompts/ (which the Factory Engineer may tune). Templates are read on every call, so
// edits apply to the next run without a restart. This file itself is protected code.
import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from './paths.mjs';

function fill(name, vars) {
  const tpl = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)).trim();
}

export const ideaBlock = (i) => [
  `Idea #${i.id}: ${i.title}`,
  `Kind: ${i.kind}${i.area ? ` · Area: ${i.area}` : ''}${i.task_type ? ` · Task type: ${i.task_type}` : ''} · Priority: ${i.priority}`,
  `From: ${i.origin}${i.origin_role ? ` (${i.origin_role})` : ''}${i.parent_id ? ` · serves idea #${i.parent_id}` : ''}`,
  i.description ? `Description:\n${i.description}` : '',
  i.spec_path ? `Spec: ${i.spec_path}` : '',
  i.rework_count ? `This idea came back from QA/owner ${i.rework_count} time(s); read the latest notes with get_idea before starting.` : '',
].filter(Boolean).join('\n');

export function triagePrompt(ideas, cfg) {
  return fill('triage', {
    COUNT: ideas.length,
    AREAS: cfg.areas.join(', '),
    TASK_TYPES: Object.keys(cfg.routing).filter((t) => t !== 'triage').join(', '),
    ROLES: cfg.roles.filter((r) => r.builds !== false).map((r) => `${r.id} (${r.does})`).join('\n- '),
    IDEAS: ideas.map(ideaBlock).join('\n\n'),
  });
}

export const specPrompt = (idea) => fill('spec', { IDEA: ideaBlock(idea) });
export const buildPrompt = (idea) => fill('build', { IDEA: ideaBlock(idea) });
export const prepPrompt = (idea, waits) => fill('prep', { IDEA: ideaBlock(idea), WAITS: waits.map((d) => `#${d}`).join(', ') });
export const qaPrompt = (idea) => fill('qa', { IDEA: ideaBlock(idea) });
export const planPrompt = (cfg, idle, slots) => fill('plan', {
  IDLE: idle.join(', ') || 'none',
  SLOTS: slots,
  ROLES: cfg.roles.filter((r) => r.builds !== false).map((r) => `${r.id} (${r.does})`).join('\n- '),
  TASK_TYPES: Object.keys(cfg.routing).filter((x) => x !== 'triage').join(', '),
  AREAS: cfg.areas.join(', '),
});
export const chatPrompt = (text) => fill('chat', { TEXT: text });
export const resumePrompt = (texts) => `${texts.join('\n\n')}\n\nContinue from where you stopped.`;
