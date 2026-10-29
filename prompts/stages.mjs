// Prompts the dispatcher sends for each pipeline stage. The Factory Engineer may tune these.

const ideaBlock = (i) => [
  `Idea #${i.id}: ${i.title}`,
  `Kind: ${i.kind}${i.area ? ` · Area: ${i.area}` : ''}${i.task_type ? ` · Task type: ${i.task_type}` : ''} · Priority: ${i.priority}`,
  `From: ${i.origin}${i.origin_role ? ` (${i.origin_role})` : ''}${i.parent_id ? ` · serves idea #${i.parent_id}` : ''}`,
  i.description ? `Description:\n${i.description}` : '',
  i.spec_path ? `Spec: ${i.spec_path}` : '',
  i.rework_count ? `This idea came back from QA/owner ${i.rework_count} time(s); read the latest notes with get_idea before starting.` : '',
].filter(Boolean).join('\n');

export function triagePrompt(ideas, cfg) {
  const roles = cfg.roles.filter((r) => r.builds !== false).map((r) => `${r.id} (${r.does})`).join('\n- ');
  return `Triage these ${ideas.length} new idea(s). For each one call update_idea once with: status "triaged" (or "rejected"
with a note if it is a duplicate or clearly out of scope), area (one of: ${cfg.areas.join(', ')}), kind
(feature | bug | polish | tuning | content | tech), task_type (the kind of work building it takes, one of:
${Object.keys(cfg.routing).filter((t) => t !== 'triage').join(', ')}), owner_role (who builds it — one of the roles
listed below, never yourself), priority (1 high – 3 low), needs_spec (true only for features that touch several
systems or need design decisions), parent_id (when it clearly serves an existing owner idea — check list_ideas),
and approval_reason (one line) if it is a brand-new feature nobody asked for.

Approval rule (owner's): ideas from the owner, bugs, polish, tuning, and anything serving an owner idea go ahead.
A brand-new feature an agent invented (a new mode, system or major content with no parent) waits for the owner —
the Factory handles that automatically when you set status "triaged"; do not try to work around it.

Roles:
- ${roles}

${ideas.map(ideaBlock).join('\n\n')}

Do not start any work on the ideas. Finish with one line per idea: id → owner_role, task_type, status.`;
}

export function specPrompt(idea) {
  return `Write a short spec for this idea, then hand it to the builder.

${ideaBlock(idea)}

Steps: read only the parts of ROADMAP.md and specs/ you need; write the spec to specs/ (follow the existing spec
naming) or as a section of the closest existing spec — goals, player-facing behaviour, numbers/config it needs,
files likely touched, and how QA will check it. Keep it under one page. Then call update_idea with
spec_path, status "building", and a note. If the idea needs a decision only the owner can make, ask_owner.`;
}

export function buildPrompt(idea) {
  return `Build this idea end to end.

${ideaBlock(idea)}

Steps: get_idea for the full history; claim_files for what you will edit; make the change following your agent
definition and the repo rules (LF line endings, push your scripts into Studio with tools/push-server.mjs when the
change is in place/, run node tools/verify.mjs). Commit only your own files. Then update_idea with status "qa",
a note telling QA exactly what to check, and a one-paragraph summary. If you cannot finish, update_idea with
status "on_hold" and the reason.`;
}

export function qaPrompt(idea) {
  return `QA this idea.

${ideaBlock(idea)}

Steps: get_idea and read the builder's latest note; check exactly what it asks (Play mode in Studio when the change
is in-game: claim Studio, test, return Studio to Edit and release it). If it passes, update_idea status "shipped"
with a one-line verdict and add the credit/log entries your role requires. If it fails, update_idea status
"building" with a precise repro so the builder can fix it. File unrelated bugs you find with propose_idea kind "bug".`;
}

export function chatPrompt(text) {
  return `The owner is messaging you directly from the Factory dashboard:

"${text}"

Answer briefly and plainly. If they ask for work, do it (or propose_idea if it is a larger new feature).`;
}

export function resumePrompt(texts) {
  return `${texts.join('\n\n')}

Continue from where you stopped.`;
}
