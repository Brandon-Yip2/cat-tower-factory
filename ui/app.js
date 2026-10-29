// Cat Tower Factory dashboard. Vanilla JS: each page mounts a skeleton once and refreshes
// its data regions whenever the server reports a change (SSE), so typing is never interrupted.
const TOKEN = document.querySelector('meta[name="factory-token"]').content;
const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));
function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function span(fromIso, toIso) {
  const m = Math.round(((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today ${t}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
}
const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const modelTier = (m) => (/opus/i.test(m) ? 'opus' : /haiku/i.test(m) ? 'haiku' : 'sonnet');

async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory-token': TOKEN }, body: JSON.stringify(body) };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}
let toastTimer;
function toast(text, err = false) {
  const t = $('#toast');
  t.textContent = text; t.className = `toast${err ? ' err' : ''}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
async function act(fn, ok) {
  try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); refreshSoon(); return r; } catch (e) { toast(e.message, true); return null; }
}

const STAGES = [
  { id: 'inbox', name: 'Inbox' }, { id: 'needs_approval', name: 'Needs approval' }, { id: 'triaged', name: 'Up next' },
  { id: 'spec', name: 'Spec' }, { id: 'building', name: 'Building' }, { id: 'staged', name: 'Staged' }, { id: 'qa', name: 'QA' },
  { id: 'on_hold', name: 'On hold' },
];
const STAGE_NAME = Object.fromEntries([...STAGES.map((s) => [s.id, s.name]), ['shipped', 'Shipped'], ['rejected', 'Rejected'], ['active', 'In progress']]);
const ORIGIN = { owner: 'you', agent: 'an agent', loop: 'a loop', qa: 'QA' };

// ---------- shared bits ----------
function questionHtml(q) {
  const choices = q.choices || [];
  const label = q.kind === 'approval' ? 'New idea to approve' : q.kind === 'failure' ? 'Run failed' : q.kind === 'hold' ? 'Idea on hold' : `${esc(q.roleName || q.role || 'An agent')} asks`;
  return `<div class="ask" data-q="${q.id}">
    <div class="who">${label}${q.idea_id ? `, idea <a href="#" data-idea="${q.idea_id}">#${q.idea_id}${q.idea_title ? ` ${esc(q.idea_title)}` : ''}</a>` : ''}, ${ago(q.created_at)}</div>
    <div class="q">${esc(q.text)}</div>
    <div class="acts">
      ${choices.map((c, i) => `<button class="btn ${i === 0 ? 'primary' : ''} small" data-answer="${esc(c)}">${esc(c)}</button>`).join('')}
      ${q.kind === 'question' ? `<form class="reply"><input type="text" placeholder="Or type an answer" aria-label="Answer"><button class="btn small">Send</button></form>` : ''}
    </div></div>`;
}
function proposalHtml(p) {
  return `<div class="proposal" data-proposal="${p.id}">
    <div class="who">Pass proposed by ${esc(p.createdByName || p.created_by)}, ${ago(p.created_at)}</div>
    <h3>${esc(p.title)}</h3>
    <p class="q">${esc(p.why)}</p>
    <ol class="tasks">${p.tasks.map((t) => `<li><b>${esc(t.roleName)}</b> ${esc(t.title || '')}${t.after?.length ? ` <span class="muted small">after task ${t.after.join(', ')}</span>` : ''}${t.description ? `<div class="muted small">${esc(t.description.slice(0, 220))}${t.description.length > 220 ? '…' : ''}</div>` : ''}</li>`).join('')}</ol>
    <textarea rows="2" placeholder="Optional: add changes or notes. They go to every task and to the Game Manager."></textarea>
    <div class="acts"><button class="btn primary" data-pass="approve">Approve</button><button class="btn" data-pass="deny">Deny</button></div>
  </div>`;
}
function wireProposals(root) {
  root.querySelectorAll('[data-proposal]').forEach((card) => {
    const id = card.dataset.proposal;
    const note = card.querySelector('textarea');
    const approve = card.querySelector('[data-pass="approve"]');
    note.addEventListener('input', () => { approve.textContent = note.value.trim() ? 'Approve with changes' : 'Approve'; });
    approve.addEventListener('click', () => act(() => api(`/api/proposals/${id}/approve`, { note: note.value }), (r) => `Approved: ${r.approved.length} tasks added to the backlog`));
    card.querySelector('[data-pass="deny"]').addEventListener('click', () => act(() => api(`/api/proposals/${id}/deny`, { reason: note.value }), 'Pass denied; the Game Manager is told why'));
  });
}
function wireQuestions(root) {
  root.querySelectorAll('[data-answer]').forEach((b) => b.addEventListener('click', () => {
    const id = b.closest('[data-q]').dataset.q;
    act(() => api(`/api/questions/${id}/answer`, { answer: b.dataset.answer }), 'Answer sent');
  }));
  root.querySelectorAll('form.reply').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = f.querySelector('input');
    if (!input.value.trim()) return;
    const id = f.closest('[data-q]').dataset.q;
    act(() => api(`/api/questions/${id}/answer`, { answer: input.value.trim() }), 'Answer sent');
  }));
  wireIdeaLinks(root);
}
function wireIdeaLinks(root) {
  root.querySelectorAll('[data-idea]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openDrawer('idea', a.dataset.idea); }));
  root.querySelectorAll('[data-run]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openDrawer('run', a.dataset.run); }));
}
function workingRow(r) {
  const state = r.status === 'parked' ? 'waiting' : 'working';
  const what = r.idea_title ? `#${r.idea_id} ${esc(r.idea_title)}` : esc(r.purpose || '');
  const note = r.status === 'parked' ? 'Waiting for your answer' : esc(r.progress_note || (r.kind === 'interactive' ? 'Your Claude Code session' : 'Working'));
  return `<div class="row click" data-run="${r.id}">
    <span class="dot ${state}"></span>
    <div class="main"><div class="title">${esc(r.roleName)}</div><div class="sub">${what}</div><div class="sub">${note}</div>
      ${r.progress ? `<div class="progress"><i style="width:${r.progress}%"></i></div>` : ''}</div>
    <div class="side-info">${r.model ? `<span class="model ${modelTier(r.model)}">${esc(r.model)}</span><br>` : ''}${span(r.started_at)}</div></div>`;
}
function toolRow(t, apps = []) {
  const h = t.holders[0];
  const app = apps.find((a) => a.resource === t.id);
  const appBtn = app ? (app.running ? '<span class="pill leaf">open</span>' : `<button class="btn small" data-open-app="${esc(app.id)}">Open</button>`) : '';
  if (!h) return `<div class="tool"><span class="ic">${esc(t.icon)}</span><div><div>${esc(t.name)}</div><div class="queue">Free${t.last ? `, last used by ${esc(t.last.roleName)} ${ago(t.last.released_at)}` : ''}</div></div><span>${appBtn}</span></div>`;
  return `<div class="tool busy"><span class="ic">${esc(t.icon)}</span><div>
      <div>${esc(t.name)}: <span class="holder">${esc(h.roleName)}</span>${h.holder_kind === 'interactive' ? ' <span class="pill">your session</span>' : ''}</div>
      <div class="queue">${esc(h.reason || 'No reason given')}${h.ideaTitle ? `, for #${h.idea_id} ${esc(h.ideaTitle)}` : ''}. Held ${span(h.claimed_at)}, last used ${ago(h.last_used_at)}.</div>
      ${t.queue.length ? `<div class="queue">Waiting: ${t.queue.map((q) => esc(q.roleName)).join(', ')}</div>` : ''}
    </div><button class="btn small" data-release="${t.id}" title="Take ${esc(t.name)} back from ${esc(h.roleName)}">Release</button></div>`;
}
function wireRelease(root) {
  root.querySelectorAll('[data-open-app]').forEach((b) => b.addEventListener('click', () => {
    b.disabled = true;
    act(() => api(`/api/apps/${b.dataset.openApp}/open`, {}), (r) => r.message);
  }));
  root.querySelectorAll('[data-release]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Force-release this tool? The agent using it will be told it is no longer theirs.')) return;
    act(() => api(`/api/tools/${b.dataset.release}/release`, {}), 'Released');
  }));
}

// ---------- pages ----------
const pages = {};

pages.home = {
  mount() {
    main.innerHTML = `<div class="page-head"><div><h1>Home</h1><p id="homeLead"></p></div></div>
      <div class="stack">
        <section class="panel needs" id="needs" hidden><h2>Needs you</h2><div id="needsList"></div></section>
        <div class="grid2">
          <div class="stack">
            <section class="panel"><h2>Working now <a href="#activity">All activity</a></h2><div class="rows" id="working"></div></section>
            <section class="panel"><h2>Tools in use <a href="#tools">Details</a></h2><div id="tools"></div></section>
          </div>
          <div class="stack">
            <section class="panel"><h2>Ideas in progress <a href="#ideas">All ideas</a></h2><div class="stack" id="homeIdeas"></div></section>
            <section class="panel"><h2>Coming up <a href="#loops">Loops</a></h2><div class="rows" id="coming"></div></section>
          </div>
        </div>
      </div>`;
  },
  async refresh(home) {
    const h = home || await api('/api/home');
    const n = h.needsYou.length + h.proposals.length;
    $('#homeLead').textContent = h.totals.paused ? 'The Factory is paused. Nothing new starts until you resume it.'
      : n ? `${n} thing${n > 1 ? 's' : ''} waiting on you. Everything else is moving on its own.`
        : h.working.length ? 'Nothing needs you. The team is working.' : 'Nothing needs you, and nobody is working right now.';
    $('#needs').hidden = !n;
    $('#needsList').innerHTML = h.proposals.map(proposalHtml).join('') + h.needsYou.map(questionHtml).join('');
    wireProposals($('#needsList'));
    wireQuestions($('#needsList'));
    $('#working').innerHTML = h.working.length ? h.working.map(workingRow).join('') : '<div class="empty">No agents running. Add an idea or start a loop.</div>';
    wireIdeaLinks($('#working'));
    $('#tools').innerHTML = h.tools.resources.map((t) => toolRow(t, h.tools.apps)).join('');
    wireRelease($('#tools'));
    $('#homeIdeas').innerHTML = h.ideas.length ? h.ideas.map(ideaCard).join('') : '<div class="empty">No ideas in progress. Add one with New idea.</div>';
    wireIdeaLinks($('#homeIdeas'));
    $('#coming').innerHTML = h.comingUp.length ? h.comingUp.map((l) => `<div class="row"><div class="main"><div class="title">${esc(l.name)}</div>
      <div class="sub">${esc(l.roleName)}, ${esc(l.schedule)}</div></div><div class="side-info">${when(l.next)}</div></div>`).join('')
      : '<div class="empty">No loops are switched on.</div>';
  },
};

pages.backlog = {
  mount() {
    main.innerHTML = `<div class="page-head"><div><h1>Backlog</h1><p>What every agent is doing and will do next, task by task. The Game Manager adds tasks under ideas as agents run low. Agents read this same list.</p></div><a class="btn" href="#tasks/triaged">All tasks by stage</a></div>
      <div class="stack"><section class="panel needs" id="blProposals" hidden><h2>Passes waiting for you</h2><div id="blProposalList"></div></section>
      <div class="roles" id="blRoles"></div>
      <section class="panel" id="blSuggest" hidden><h2>Suggestions from agents</h2><p class="muted small">New features agents came up with. The Game Manager bundles good ones into its next pass; you can also approve one directly from its page.</p><div class="rows" id="blSuggestList"></div></section></div>`;
  },
  async refresh() {
    const b = await api('/api/backlog');
    $('#blProposals').hidden = !b.proposals.length;
    $('#blProposalList').innerHTML = b.proposals.map(proposalHtml).join('');
    wireProposals($('#blProposalList'));
    const item = (i) => `<div class="row"><div class="main click" data-idea="${i.id}"><div>#${i.id} ${esc(i.title)}</div>
      <div class="sub">${esc(STAGE_NAME[i.status] || i.status)}${i.waiting?.length ? `, waiting for ${i.waiting.map((d) => '#' + d).join(', ')}` : ''}${i.ideaTitle ? `, for ${esc(i.ideaTitle)}` : ''}</div></div>
      <div class="acts"><button class="btn small" data-move="up" data-id="${i.id}" title="Earlier" aria-label="Move earlier">↑</button><button class="btn small" data-move="down" data-id="${i.id}" title="Later" aria-label="Move later">↓</button><button class="btn small danger" data-drop="${i.id}" title="Remove from the backlog" aria-label="Remove">✕</button></div></div>`;
    $('#blRoles').innerHTML = b.roles.map((r) => `<section class="panel role">
      <h2><span><span class="dot ${r.working.length ? 'working' : r.next.length ? '' : 'queued'}"></span> ${esc(r.name)}</span><span class="muted small">${r.working.length ? `${r.working.length} working` : r.next.length ? 'work ready' : 'nothing queued'}</span></h2>
      ${r.working.map((w) => `<div class="row click" data-run="${w.id}"><div class="main"><div class="title">Now: ${esc(w.idea_title || w.purpose)}</div><div class="sub">${esc(w.progress_note || '')} ${span(w.started_at)}</div></div></div>`).join('')}
      ${r.next.length ? `<h3>Up next</h3><div class="rows">${r.next.map(item).join('')}</div>` : ''}
      ${r.waiting.length ? `<h3>Waiting</h3><div class="rows">${r.waiting.map(item).join('')}</div>` : ''}
      ${!r.working.length && !r.next.length && !r.waiting.length ? '<div class="empty">Nothing queued. The Game Manager plans more when agents run low.</div>' : ''}
    </section>`).join('');
    const roles = $('#blRoles');
    wireIdeaLinks(roles);
    roles.querySelectorAll('[data-move]').forEach((x) => x.addEventListener('click', () => act(() => api(`/api/ideas/${x.dataset.id}/move`, { dir: x.dataset.move }))));
    roles.querySelectorAll('[data-drop]').forEach((x) => x.addEventListener('click', () => { if (confirm('Remove this task from the backlog?')) act(() => api(`/api/ideas/${x.dataset.drop}/status`, { status: 'rejected', note: 'removed from the backlog by the owner' }), 'Removed'); }));
    $('#blSuggest').hidden = !b.suggestions.length;
    $('#blSuggestList').innerHTML = b.suggestions.map((i) => `<div class="row click" data-idea="${i.id}"><div class="main"><div>#${i.id} ${esc(i.title)}</div><div class="sub">From ${esc(i.originName || 'an agent')}, ${ago(i.created_at)}</div></div></div>`).join('');
    wireIdeaLinks($('#blSuggestList'));
  },
};

const IDEA_STATUS = { needs_approval: 'Waiting for you', active: 'In progress', on_hold: 'On hold', shipped: 'Done', rejected: 'Turned down' };
function ideaCard(i) {
  const total = i.taskCount - i.dropped;
  const pct = total ? Math.round((i.done / total) * 100) : 0;
  const now = i.workingNames?.length ? `Now: ${i.workingNames.map(esc).join(', ')}` : i.status === 'active' ? (total ? 'Waiting for a free agent' : 'The Game Manager is planning its tasks') : '';
  return `<div class="idea-card click" data-idea="${i.id}">
    <div class="idea-top"><h3>${esc(i.title)}</h3><span class="pill ${i.status === 'active' ? 'leaf' : i.status === 'needs_approval' ? 'attention' : ''}">${esc(IDEA_STATUS[i.status] || i.status)}</span></div>
    ${i.description ? `<p class="muted">${esc(i.description.length > 240 ? `${i.description.slice(0, 239)}…` : i.description)}</p>` : ''}
    ${total ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
    <div class="sub">${total ? `${i.done} of ${total} tasks done` : 'No tasks yet'}${now ? `. ${now}` : ''}</div>
  </div>`;
}

pages.ideas = {
  mount() {
    main.innerHTML = `<div class="page-head"><div><h1>Ideas</h1><p>The big things the team is working on, in plain words. Open one to see the tasks under it and who is doing them. The Game Manager proposes new ideas; you approve them.</p></div>
        <button class="btn primary" id="ideasNew">New idea</button></div>
      <div class="stack">
        <section class="panel needs" id="ipWaiting" hidden><h2>Waiting for you</h2><div id="ipProposals"></div></section>
        <section><h2>In progress</h2><div class="idea-grid" id="ipActive"></div></section>
        <section id="ipHoldWrap" hidden><h2>On hold</h2><div class="idea-grid" id="ipHold"></div></section>
        <details class="panel" id="ipDoneWrap"><summary><b>Done</b> <span class="muted" id="ipDoneCount"></span></summary><div class="idea-grid" id="ipDone" style="margin-top:12px"></div></details>
        <details class="panel" id="ipNoWrap" hidden><summary><b>Turned down</b></summary><div class="idea-grid" id="ipNo" style="margin-top:12px"></div></details>
      </div>`;
    $('#ideasNew').addEventListener('click', () => openDrawer('new-idea'));
  },
  async refresh() {
    const d = await api('/api/ideas?level=idea');
    const by = (s) => d.ideas.filter((i) => i.status === s);
    $('#ipWaiting').hidden = !d.proposals.length;
    $('#ipProposals').innerHTML = d.proposals.map(proposalHtml).join('');
    wireProposals($('#ipProposals'));
    const fill = (sel, list, empty) => { $(sel).innerHTML = list.length ? list.map(ideaCard).join('') : `<div class="empty">${empty}</div>`; wireIdeaLinks($(sel)); };
    fill('#ipActive', by('active'), 'Nothing in progress. Add an idea, or the Game Manager will propose one when the team runs out of work.');
    $('#ipHoldWrap').hidden = !by('on_hold').length;
    fill('#ipHold', by('on_hold'), '');
    $('#ipDoneCount').textContent = `(${by('shipped').length})`;
    fill('#ipDone', by('shipped'), 'Nothing finished yet.');
    $('#ipNoWrap').hidden = !by('rejected').length;
    fill('#ipNo', by('rejected'), '');
  },
};

// Small Markdown renderer for the Bible: headings, paragraphs, lists, tables, quotes, rules, bold,
// italics, code and links. Everything is escaped first, so file content can never inject HTML.
function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1');
}
function md(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim() || /^<!--.*-->$/.test(l.trim())) { i += 1; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { const n = Math.min(h[1].length + 1, 5); out.push(`<h${n}>${mdInline(h[2])}</h${n}>`); i += 1; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) { out.push('<hr>'); i += 1; continue; }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i += 1; }
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      out.push(`<blockquote>${md(q.join('\n'))}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m) { items.push(m[3]); i += 1; } else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ` ${lines[i].trim()}`; i += 1; } else break;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${mdInline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|\s*([-*]|\d+\.)\s|\s*---\s*$)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) { para.push(lines[i].trim()); i += 1; }
    if (para.length) out.push(`<p>${mdInline(para.join(' '))}</p>`); else i += 1;
  }
  return out.join('\n');
}

let bibleTab = null;
pages.bible = {
  mount(sub) {
    if (sub) bibleTab = sub;
    main.innerHTML = `<div class="page-head"><div><h1>Game Bible</h1><p>Everything about Cat Tower in plain words: the world, the story, how it plays, every item, creature and boss. The team updates it whenever an idea is finished.</p></div></div>
      <div class="tabs" id="bibleTabs"></div>
      <article class="panel bible" id="bibleBody"></article>`;
  },
  async refresh() {
    const b = await api('/api/bible');
    const tabs = [...b.sections, ...(b.changelog ? [{ ...b.changelog, id: 'changelog' }] : [])];
    if (!tabs.length) { $('#bibleBody').innerHTML = '<div class="empty">The Bible has not been started yet.</div>'; return; }
    if (!tabs.some((t) => t.id === bibleTab)) bibleTab = tabs[0].id;
    $('#bibleTabs').innerHTML = tabs.map((t) => `<button class="tab ${t.id === bibleTab ? 'on' : ''}" data-tab="${esc(t.id)}">${esc(t.title)}</button>`).join('');
    $('#bibleTabs').querySelectorAll('[data-tab]').forEach((x) => x.addEventListener('click', () => { location.hash = `#bible/${x.dataset.tab}`; }));
    const cur = tabs.find((t) => t.id === bibleTab);
    const scroll = window.scrollY;
    $('#bibleBody').innerHTML = `${md(cur.markdown)}<p class="muted small bible-updated">Last updated ${when(cur.updated)}.</p>`;
    window.scrollTo(0, scroll);
  },
};

const ideaFilters = { tab: 'inbox', pass: '', area: '', origin: '', q: '' };
pages.tasks = {
  mount(sub) {
    if (sub) ideaFilters.tab = sub === 'shipped' ? 'done' : sub;
    main.innerHTML = `<div class="page-head"><div><h1>All tasks</h1><p>Every task by stage. Ideas group them; this view is for digging in.</p></div>
        <button class="btn primary" id="ideasNew">New idea</button></div>
      <div class="tabs" id="tabs"></div>
      <div class="filters">
        <select id="fPass" aria-label="Pass"></select>
        <select id="fArea" aria-label="Area"><option value="">Any area</option></select>
        <select id="fOrigin" aria-label="Came from"><option value="">From anyone</option><option value="owner">From you</option><option value="agent">From an agent</option><option value="loop">From a loop</option><option value="qa">From QA</option></select>
        <span></span>
        <input type="search" id="fQ" placeholder="Search ideas" aria-label="Search ideas">
      </div>
      <section class="panel"><div id="ideaList"></div></section>`;
    $('#ideasNew').hidden = true;
    for (const [id, key] of [['#fPass', 'pass'], ['#fArea', 'area'], ['#fOrigin', 'origin']]) {
      $(id).addEventListener('change', (e) => { ideaFilters[key] = e.target.value; this.refresh(); });
    }
    let t;
    $('#fQ').value = ideaFilters.q;
    $('#fQ').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { ideaFilters.q = e.target.value; this.refresh(); }, 250); });
  },
  async refresh() {
    const f = ideaFilters;
    const qs = new URLSearchParams({ pass: f.pass || '', area: f.area, origin: f.origin, q: f.q });
    if (f.tab === 'done') qs.set('group', 'done'); else qs.set('status', f.tab);
    const data = await api(`/api/ideas?${qs}`);
    const passSel = $('#fPass');
    if (passSel && !passSel.dataset.filled) {
      passSel.innerHTML = `${data.passes.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}<option value="all">All passes</option>`;
      passSel.value = f.pass || data.pass || 'all';
      $('#fArea').insertAdjacentHTML('beforeend', data.areas.map((a) => `<option>${esc(a)}</option>`).join(''));
      passSel.dataset.filled = '1';
    }
    const c = data.counts;
    const done = (c.shipped || 0) + (c.rejected || 0);
    $('#tabs').innerHTML = [...STAGES, { id: 'done', name: 'Done' }].map((s) => {
      const n = s.id === 'done' ? done : c[s.id] || 0;
      if (s.id === 'needs_approval' && !n && f.tab !== s.id) return '';
      if (s.id === 'on_hold' && !n && f.tab !== s.id) return '';
      return `<button class="tab ${f.tab === s.id ? 'on' : ''} ${s.id === 'needs_approval' && n ? 'attn' : ''}" data-tab="${s.id}">${s.name}<b>${n}</b></button>`;
    }).join('');
    $('#tabs').querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { f.tab = b.dataset.tab; location.hash = `#tasks/${f.tab}`; }));
    const list = $('#ideaList');
    if (!data.ideas.length) {
      list.innerHTML = `<div class="empty">${f.tab === 'inbox' ? 'The inbox is empty. New ideas from you, the loops and QA land here first.' : `Nothing in ${esc(STAGE_NAME[f.tab] || 'Done')}${f.q || f.area || f.origin ? ' for these filters' : ''}.`}</div>`;
      return;
    }
    const row = (i) => `<div class="row click" data-idea="${i.id}">
      <div class="main"><div class="title">#${i.id} ${esc(i.title)}</div>
      <div class="sub">From ${esc(i.origin === 'owner' ? 'you' : i.originName || ORIGIN[i.origin])}${i.area ? `, ${esc(i.area)}` : ''}${i.owner_role ? `, built by ${esc(i.ownerName)}` : ''}${i.rework_count ? `, sent back ${i.rework_count}×` : ''}${i.waiting?.length ? `, waiting for ${i.waiting.map((d) => `#${d}`).join(', ')}` : ''}</div></div>
      <div class="side-info">${i.status === 'rejected' ? '<span class="pill">Rejected</span>' : i.rating === 'redo' ? '<span class="pill attention">Redo</span>' : i.rating === 'good' ? '<span class="pill leaf">Good</span>' : ''}<br>${ago(i.shipped_at || i.updated_at)}</div></div>`;
    if (f.tab !== 'done') { list.innerHTML = `<div class="rows">${data.ideas.map(row).join('')}</div>`; wireIdeaLinks(list); return; }
    const weeks = new Map();
    for (const i of data.ideas) {
      const d = new Date(i.shipped_at || i.updated_at);
      const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0);
      const key = monday.toISOString();
      if (!weeks.has(key)) weeks.set(key, []);
      weeks.get(key).push(i);
    }
    const thisWeek = (() => { const m = new Date(); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); m.setHours(0, 0, 0, 0); return m.toISOString(); })();
    list.innerHTML = [...weeks].map(([k, items], idx) => `<details class="week" ${idx === 0 ? 'open' : ''}><summary><span>${k === thisWeek ? 'This week' : `Week of ${new Date(k).toLocaleDateString([], { day: 'numeric', month: 'short' })}`}</span><span>${items.length} shipped or closed</span></summary>
      <div class="rows">${items.map(row).join('')}</div></details>`).join('');
    wireIdeaLinks(list);
  },
};

let selectedRole = null;
pages.agents = {
  mount(sub) {
    if (sub) selectedRole = sub;
    main.innerHTML = `<div class="page-head"><div><h1>Agents</h1><p>Every role the Factory can start. Idle agents start when work reaches them, or when you message them.</p></div></div>
      <div class="agents">
        <section class="panel"><div id="roster"></div></section>
        <section class="panel" id="chatPanel"><h2 id="chatTitle">Pick an agent to talk to</h2><div class="chat" id="chat"></div><div class="typing" id="typing"></div>
          <form class="composer" id="composer" hidden><textarea id="chatText" rows="2" placeholder="Message this agent. Enter to send, Shift+Enter for a new line"></textarea><button class="btn primary">Send</button></form>
          <div id="roleRuns"></div></section>
      </div>
      <section class="panel" style="margin-top:22px"><h2>Models and token use</h2><div id="models"></div></section>`;
    const form = $('#composer');
    const text = $('#chatText');
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = text.value.trim();
      if (!v || !selectedRole) return;
      text.value = '';
      await act(() => api(`/api/agents/${selectedRole}/chat`, { text: v }), (r) => (r.delivered === 'live' ? 'Delivered to the running agent' : 'Agent started'));
    });
  },
  async refresh() {
    const [roles, models] = await Promise.all([api('/api/agents'), api('/api/models')]);
    if (!selectedRole && roles.length) selectedRole = (roles.find((r) => r.status !== 'idle') || roles[0]).id;
    $('#roster').innerHTML = roles.map((r) => `<div class="agent ${r.id === selectedRole ? 'on' : ''}" data-role="${r.id}">
      <span class="dot ${r.status}"></span>
      <div><div class="name">${esc(r.name)}</div><div class="sub muted small">${r.current ? esc(r.current.idea_title ? `#${r.current.idea_id} ${r.current.idea_title}` : r.current.purpose) : esc(r.does)}</div></div>
      <div class="side-info small muted"><span class="model ${modelTier(r.defaultModel)}">${esc(r.defaultModel)}</span><br>${r.week.runs ? `${r.week.runs} run${r.week.runs > 1 ? 's' : ''} this week` : 'No runs this week'}</div></div>`).join('');
    $('#roster').querySelectorAll('[data-role]').forEach((el) => el.addEventListener('click', () => { selectedRole = el.dataset.role; location.hash = `#agents/${selectedRole}`; }));
    if (selectedRole) await this.refreshChat(roles.find((r) => r.id === selectedRole));
    this.renderModels(models);
  },
  async refreshChat(role) {
    if (!role) return;
    const d = await api(`/api/agents/${role.id}`);
    $('#chatTitle').textContent = `Talk to ${role.name}`;
    $('#composer').hidden = false;
    const chat = $('#chat');
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
    chat.innerHTML = d.chat.length ? d.chat.map((m) => `<div class="msg ${m.from_role === 'owner' ? 'me' : 'them'}">${esc(m.text)}<span class="when">${hhmm(m.ts)}</span></div>`).join('')
      : `<div class="empty">No messages yet. ${esc(role.does)}</div>`;
    if (atBottom) chat.scrollTop = chat.scrollHeight;
    const live = d.runs.find((r) => r.status === 'running');
    $('#typing').textContent = d.working && live ? `${role.name} is working: ${live.progress_note || live.purpose}` : '';
    $('#roleRuns').innerHTML = d.runs.length ? `<h3 style="margin-top:18px">Recent runs</h3><div class="rows">${d.runs.slice(0, 6).map((r) => `<div class="row click" data-run="${r.id}">
      <div class="main"><div>${esc(r.idea_title || r.purpose)}</div><div class="sub">${esc(r.status)}, ${ago(r.started_at)}</div></div>
      <div class="side-info"><span class="model ${modelTier(r.model)}">${esc(r.model)}</span><br>${tokens(r.tokens)}</div></div>`).join('')}</div>` : '';
    wireIdeaLinks($('#roleRuns'));
  },
  renderModels(m) {
    const t = m.tokens;
    const change = t.prevWeek ? Math.round(((t.week - t.prevWeek) / t.prevWeek) * 100) : null;
    $('#models').innerHTML = `<div class="kpis">
        <div class="kpi"><span class="muted small">Tokens this week</span><b>${tokens(t.week)}</b><span class="muted small">${change === null ? 'no data last week' : `${change > 0 ? '+' : ''}${change}% vs last week`}</span></div>
        <div class="kpi"><span class="muted small">Per shipped idea</span><b>${t.perShipped ? tokens(t.perShipped) : '–'}</b><span class="muted small">${t.shipped} shipped this week</span></div>
        <div class="kpi"><span class="muted small">Redo rate</span><b>${t.redoRate === null ? '–' : `${Math.round(t.redoRate * 100)}%`}</b><span class="muted small">of runs you rated</span></div>
        <div class="kpi"><span class="muted small">Biggest spender</span><b style="font-size:1rem">${t.spenders[0] ? esc(t.spenders[0].roleName) : '–'}</b><span class="muted small">${t.spenders[0] ? tokens(t.spenders[0].t) : ''}</span></div>
      </div>
      <p class="muted small">Tokens count input, output and cache writes. Cache reads are cheap and not counted. Mark a result "Redo, model wasn't strong enough" twice in five runs and that task type moves up a model.</p>
      <table class="t"><thead><tr><th>Task type</th><th>Model</th><th>Why</th><th>Track record</th><th></th></tr></thead><tbody>
      ${m.routing.map((r) => {
        const ev = r.evidence.map((e) => `${esc(e.model)}: ${e.runs} runs, ${e.redo}/${e.rated} redo, ~${tokens(Math.round(e.avg_tokens || 0))}`).join('<br>') || '<span class="muted">no runs yet</span>';
        return `<tr><td>${esc(r.taskType)}</td><td><span class="model ${modelTier(r.model)}">${esc(r.model)}</span>${r.source === 'learned' ? ' <span class="pill honey">learned</span>' : ''}</td>
          <td>${esc(r.why)}</td><td class="small">${ev}</td><td>${r.source === 'learned' ? `<button class="btn small" data-reset="${esc(r.taskType)}">Back to ${esc(r.configModel)}</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
    $('#models').querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => act(() => api(`/api/models/${b.dataset.reset}/reset`, {}), 'Routing reset')));
  },
};

pages.loops = {
  mount() {
    main.innerHTML = `<div class="page-head"><div><h1>Loops</h1><p>Work that runs on a timer while your PC is on. A loop missed while the PC was off runs once when the Factory starts, if it was due in the last 12 hours.</p></div></div>
      <section class="panel"><div id="loops"></div></section>`;
  },
  async refresh() {
    const loops = await api('/api/loops');
    $('#loops').innerHTML = loops.map((l) => `<div class="loop">
      <label class="toggle" title="${l.enabled ? 'Switch off' : 'Switch on'}"><input type="checkbox" data-toggle="${l.id}" ${l.enabled ? 'checked' : ''} aria-label="Run ${esc(l.name)} automatically"><span></span></label>
      <div><div class="title"><b>${esc(l.name)}</b></div><div class="sub muted small">${esc(l.schedule)}, run by ${esc(l.roleName)}</div>
        ${l.lastFiredAt ? `<div class="small">Last run ${ago(l.lastFiredAt)}: ${l.lastRunId ? `<a href="#" data-run="${l.lastRunId}">${esc(l.lastStatus || 'started')}</a>` : 'no run yet'}${l.lastSummary ? `, ${esc(l.lastSummary.slice(0, 140))}` : ''}</div>` : ''}</div>
      <div class="side-info small muted">${l.enabled ? `Next ${when(l.next)}` : 'Off'}</div>
      <button class="btn small" data-run-loop="${l.id}">Run now</button></div>`).join('');
    const root = $('#loops');
    root.querySelectorAll('[data-toggle]').forEach((c) => c.addEventListener('change', () => act(() => api(`/api/loops/${c.dataset.toggle}/toggle`, { enabled: c.checked }), c.checked ? 'Loop on' : 'Loop off')));
    root.querySelectorAll('[data-run-loop]').forEach((b) => b.addEventListener('click', () => act(() => api(`/api/loops/${b.dataset.runLoop}/run`, {}), 'Loop started')));
    wireIdeaLinks(root);
  },
};

pages.tools = {
  mount() {
    main.innerHTML = `<div class="page-head"><div><h1>Tools</h1><p>Tools only one agent can drive at a time. Agents take a tool when they first use it and give it back when they finish, or after it sits idle. Anyone else waits in line.</p></div></div>
      <div class="grid2"><section class="panel"><h2>Single-user tools</h2><div id="toolList"></div></section>
      <section class="panel"><h2>Files being edited</h2><div class="rows" id="files"></div></section></div>`;
  },
  async refresh() {
    const t = await api('/api/tools');
    $('#toolList').innerHTML = t.resources.map((x) => toolRow(x, t.apps)).join('');
    wireRelease($('#toolList'));
    $('#files').innerHTML = t.files.length ? t.files.map((f) => `<div class="row"><div class="main"><div>${esc(f.path)}</div><div class="sub">${esc(f.roleName)}${f.reason ? `, ${esc(f.reason)}` : ''}</div></div><div class="side-info">${ago(f.claimed_at)}</div></div>`).join('')
      : '<div class="empty">No agent has claimed files right now.</div>';
  },
};

pages.activity = {
  mount() {
    main.innerHTML = `<div class="page-head"><div><h1>Activity</h1><p>Every run, factory or your own Claude Code sessions, newest first. Open one to see each step it took.</p></div>
      <select id="aKind" style="width:auto"><option value="">All runs</option><option value="factory">Factory runs</option><option value="interactive">Your sessions</option></select></div>
      <div class="grid2"><section class="panel"><h2>Runs</h2><div class="rows" id="runs"></div></section>
      <section class="panel"><h2>Live feed</h2><div class="timeline" id="feed"></div></section></div>`;
    $('#aKind').addEventListener('change', () => this.refresh());
  },
  async refresh() {
    const kind = $('#aKind')?.value || '';
    const [runs, feed] = await Promise.all([api(`/api/runs?limit=60${kind ? `&kind=${kind}` : ''}`), api('/api/activity?limit=60')]);
    $('#runs').innerHTML = runs.length ? runs.map((r) => `<div class="row click" data-run="${r.id}">
      <span class="dot ${r.live ? 'working' : r.status === 'parked' ? 'waiting' : ''}"></span>
      <div class="main"><div class="title">${esc(r.roleName)}</div><div class="sub">${esc(r.idea_title ? `#${r.idea_id} ${r.idea_title}` : r.purpose || '')}</div></div>
      <div class="side-info">${esc(r.status)}${r.rating === 'redo' ? ', redo' : ''}<br>${ago(r.started_at)}, ${tokens(r.tokens)}</div></div>`).join('')
      : '<div class="empty">No runs yet.</div>';
    wireIdeaLinks($('#runs'));
    $('#feed').innerHTML = feed.map((a) => `<div><span class="ts">${hhmm(a.ts)}</span><span><b>${esc(a.roleName || '')}</b> ${esc(a.summary)}</span></div>`).join('') || '<div class="empty">Quiet.</div>';
  },
};

pages.improvements = {
  mount() {
    main.innerHTML = `<div class="page-head"><div><h1>Improvements</h1><p>Changes the Factory made to itself: instructions, agent definitions, model routing and loops. Each says why. Undo any of them here.</p></div></div>
      <section class="panel"><div class="rows" id="imps"></div></section>`;
  },
  async refresh() {
    const list = await api('/api/improvements');
    $('#imps').innerHTML = list.length ? list.map((i) => `<div class="row"><div class="main"><div class="title">${esc(i.title)}</div>
      <div class="sub" style="white-space:normal">${esc(i.why)}</div>
      ${i.files.length ? `<div class="sub">${i.files.map(esc).join(', ')}</div>` : ''}
      <div class="sub">${esc(i.kind)}, by ${esc(i.actor)}, ${ago(i.ts)}${i.commit_sha ? `, commit ${esc(i.commit_sha.slice(0, 8))}` : ''}</div></div>
      <div>${i.status === 'reverted' ? '<span class="pill">Undone</span>' : `<button class="btn small" data-revert="${i.id}">Undo</button>`}</div></div>`).join('')
      : '<div class="empty">No self-improvements yet. The self-review loop runs every three days.</div>';
    $('#imps').querySelectorAll('[data-revert]').forEach((b) => b.addEventListener('click', () => {
      if (confirm('Undo this improvement? Code changes are undone with a git revert commit.')) act(() => api(`/api/improvements/${b.dataset.revert}/revert`, {}), 'Undone');
    }));
  },
};

// ---------- drawer: idea, run, new idea ----------
let drawer = null;
function openDrawer(type, id) { drawer = { type, id }; $('#drawer').hidden = false; $('#scrim').hidden = false; renderDrawer(true); }
function closeDrawer() { drawer = null; $('#drawer').hidden = true; $('#scrim').hidden = true; }
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer) closeDrawer(); });

// A high-level idea: plain summary, progress, and the tasks under it with who is on them.
function renderIdeaDrawer(el, close, i) {
  const scroll = el.scrollTop;
  const tasks = i.children;
  const live = tasks.filter((t) => t.workingName);
  const open = tasks.filter((t) => !t.workingName && !['shipped', 'rejected'].includes(t.status));
  const done = tasks.filter((t) => t.status === 'shipped');
  const total = tasks.filter((t) => t.status !== 'rejected').length;
  const taskRow = (t) => `<div class="row click" data-idea="${t.id}"><div class="main"><div>${esc(t.title)}</div>
    <div class="sub">${esc(t.ownerName || 'unassigned')}, ${esc(STAGE_NAME[t.status] || t.status)}${t.waiting?.length ? `, waiting for ${t.waiting.map((x) => '#' + x).join(', ')}` : ''}</div></div></div>`;
  el.innerHTML = `${close}<h1>${esc(i.title)}</h1>
    <p><span class="pill ${i.status === 'active' ? 'leaf' : i.status === 'needs_approval' ? 'attention' : ''}">${esc(IDEA_STATUS[i.status] || i.status)}</span>
      <span class="muted">${i.origin === 'owner' ? 'Your idea' : `Proposed by ${esc(i.origin_role || 'an agent')}`}</span></p>
    ${i.description ? `<p style="white-space:pre-wrap">${esc(i.description)}</p>` : ''}
    ${total ? `<div class="progress" style="max-width:none"><i style="width:${Math.round((done.length / total) * 100)}%"></i></div><p class="small muted">${done.length} of ${total} tasks done</p>` : ''}
    ${i.status === 'needs_approval' ? `<section><div class="rate"><button class="btn primary" id="dApprove">Approve</button><button class="btn" id="dReject">Turn down</button></div></section>` : ''}
    <section><h3>Being worked on now</h3>${live.length ? `<div class="rows">${live.map((t) => `<div class="row click" data-idea="${t.id}"><span class="dot working"></span><div class="main"><div class="title">${esc(t.workingName)}</div><div class="sub">${esc(t.title)}</div></div></div>`).join('')}</div>` : '<p class="muted">Nobody right now.</p>'}</section>
    <section><h3>Planned tasks</h3>${open.length ? `<div class="rows">${open.map(taskRow).join('')}</div>` : `<p class="muted">${i.status === 'active' ? 'None left. The Game Manager adds tasks or closes the idea when it is finished.' : 'None.'}</p>`}</section>
    ${done.length ? `<details><summary><b>Done</b> <span class="muted">(${done.length})</span></summary><div class="rows">${done.map(taskRow).join('')}</div></details>` : ''}
    ${!i.standing && !['shipped', 'rejected'].includes(i.status) ? `<section class="rate"><button class="btn small" id="dHold">${i.status === 'on_hold' ? 'Resume' : 'Put on hold'}</button><button class="btn small" id="dFinish">Mark as done</button><button class="btn small danger" id="dDrop">Drop this idea</button></section>` : ''}`;
  el.scrollTop = scroll;
  $('#dClose').addEventListener('click', closeDrawer);
  wireIdeaLinks(el);
  $('#dApprove')?.addEventListener('click', () => act(() => api(`/api/ideas/${i.id}/approve`, {}), 'Approved'));
  $('#dReject')?.addEventListener('click', () => act(() => api(`/api/ideas/${i.id}/reject`, {}), 'Turned down'));
  $('#dHold')?.addEventListener('click', () => act(() => api(`/api/ideas/${i.id}/status`, { status: i.status === 'on_hold' ? 'active' : 'on_hold', note: 'by owner' }), 'Updated'));
  $('#dFinish')?.addEventListener('click', () => { if (confirm('Mark this idea as done? Open tasks under it stay in the backlog unless you drop them.')) act(() => api(`/api/ideas/${i.id}/status`, { status: 'shipped', note: 'marked done by the owner' }), 'Marked done'); });
  $('#dDrop')?.addEventListener('click', () => { if (confirm('Drop this idea and stop its open tasks?')) act(() => api(`/api/ideas/${i.id}/drop`, {}), 'Dropped'); });
}

async function renderDrawer(first = false) {
  if (!drawer) return;
  const el = $('#drawer');
  const close = '<button class="btn small close" id="dClose" aria-label="Close">Close</button>';
  if (drawer.type === 'new-idea') {
    if (!first) return;
    el.innerHTML = `${close}<h1>New idea</h1><p class="muted">Describe what you want in your own words. The Game Manager breaks it into tasks for the team, and agents start as soon as they are free.</p>
      <form class="form" id="ideaForm">
        <label class="field">What should the game get?<input type="text" name="title" required maxlength="140" placeholder="Make the first boss fight more exciting"></label>
        <label class="field">More detail (optional)<textarea name="description" rows="6" placeholder="Why it matters, what good looks like, games you like that do it well, anything to avoid"></textarea></label>
        <label class="field">How important?<select name="priority"><option value="1">High</option><option value="2" selected>Normal</option><option value="3">Low</option></select></label>
        <div><button class="btn primary">Add idea</button></div></form>`;
    $('#dClose').addEventListener('click', closeDrawer);
    $('#ideaForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const r = await act(() => api('/api/ideas', { ...f, priority: Number(f.priority) }), (i) => `Idea added: the Game Manager will plan its tasks`);
      if (r) openDrawer('idea', r.id);
    });
    $('input[name=title]', el).focus();
    return;
  }
  if (drawer.type === 'idea') {
    const i = await api(`/api/ideas/${drawer.id}`);
    if (i.level === 'idea') { renderIdeaDrawer(el, close, i); return; }
    const scroll = el.scrollTop;
    const canRate = ['shipped', 'qa', 'on_hold'].includes(i.status) || i.runs.length;
    el.innerHTML = `${close}<h1>#${i.id} ${esc(i.title)}</h1>
      <p><span class="pill ${i.status === 'needs_approval' ? 'attention' : i.status === 'shipped' ? 'leaf' : ''}">${esc(STAGE_NAME[i.status] || i.status)}</span>
        <span class="muted">${i.parent ? `Task in <a href="#" data-idea="${i.parent.id}">${esc(i.parent.title)}</a>, from` : 'From'} ${esc(i.origin === 'owner' ? 'you' : i.origin_role || ORIGIN[i.origin])}${i.owner_role ? `, built by ${esc(i.ownerName)}` : ''}${i.task_type ? `, ${esc(i.task_type)}` : ''}</span></p>
      ${i.deps.length ? `<p class="small">Starts after ${i.deps.map((d) => `<a href="#" data-idea="${d.id}">#${d.id} ${esc(d.title)}</a> (${esc(STAGE_NAME[d.status] || d.status)})`).join(', ')}.</p>` : ''}
      ${i.description ? `<p style="white-space:pre-wrap">${esc(i.description)}</p>` : ''}
      ${i.summary ? `<section><h3>What shipped</h3><p style="white-space:pre-wrap">${esc(i.summary)}</p></section>` : ''}
      ${i.spec_path ? `<p class="small">Spec: ${esc(i.spec_path)}</p>` : ''}
      ${i.status === 'needs_approval' ? `<section><p>An agent came up with this new idea. It waits for you before any work starts.</p><div class="rate"><button class="btn primary" id="dApprove">Approve</button><button class="btn" id="dReject">Reject</button></div></section>` : ''}
      ${canRate ? `<section><h3>How did it turn out?</h3><div class="rate">
        <button class="btn" id="dGood">Good</button>
        <select id="dReason" style="width:auto">${Object.entries(i.redoReasons).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <button class="btn danger" id="dRedo">Redo</button></div>
        <input type="text" id="dNote" placeholder="Optional note for the agent" style="margin-top:8px">
        ${i.rating ? `<p class="small muted" style="margin-top:6px">You rated it ${esc(i.rating)}${i.rating_note ? `: ${esc(i.rating_note)}` : ''}.</p>` : ''}</section>` : ''}
      <section><h3>Runs</h3>${i.runs.length ? `<div class="rows">${i.runs.map((r) => `<div class="row click" data-run="${r.id}"><div class="main"><div>${esc(r.roleName)}: ${esc(r.purpose || '')}</div>
        <div class="sub">${esc(r.status)}, ${ago(r.started_at)}${r.rating ? `, rated ${esc(r.rating)}` : ''}</div></div>
        <div class="side-info"><span class="model ${modelTier(r.model || '')}">${esc(r.model || '')}</span><br>${tokens(r.input_tokens + r.output_tokens + r.cache_write)}</div></div>`).join('')}</div>` : '<p class="muted">No runs yet.</p>'}</section>
      <section><h3>History</h3><div class="timeline">${i.events.map((e) => `<div><span class="ts">${new Date(e.ts).toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hhmm(e.ts)}</span><span><b>${esc(e.actorName)}</b> ${esc(e.text)}</span></div>`).join('')}</div></section>
      ${!['shipped', 'rejected'].includes(i.status) ? `<section class="rate"><button class="btn small" id="dHold">${i.status === 'on_hold' ? 'Resume' : 'Put on hold'}</button><button class="btn small danger" id="dDrop">Reject</button></section>` : ''}`;
    el.scrollTop = scroll;
    $('#dClose').addEventListener('click', closeDrawer);
    wireIdeaLinks(el);
    $('#dApprove')?.addEventListener('click', () => act(() => api(`/api/ideas/${i.id}/approve`, {}), 'Approved'));
    $('#dReject')?.addEventListener('click', () => act(() => api(`/api/ideas/${i.id}/reject`, {}), 'Rejected'));
    $('#dGood')?.addEventListener('click', () => act(() => api(`/api/ideas/${i.id}/rate`, { verdict: 'good', note: $('#dNote').value }), 'Thanks, noted'));
    $('#dRedo')?.addEventListener('click', () => act(() => api(`/api/ideas/${i.id}/rate`, { verdict: 'redo', reason: $('#dReason').value, note: $('#dNote').value }),
      (r) => (r.bumped ? `Sent back. ${r.bumped.taskType} now uses ${r.bumped.to}.` : 'Sent back for a redo')));
    $('#dHold')?.addEventListener('click', () => act(() => api(`/api/ideas/${i.id}/status`, { status: i.status === 'on_hold' ? 'triaged' : 'on_hold', note: 'by owner' }), 'Updated'));
    $('#dDrop')?.addEventListener('click', () => { if (confirm('Reject this idea?')) act(() => api(`/api/ideas/${i.id}/status`, { status: 'rejected', note: 'rejected by owner' }), 'Rejected'); });
    return;
  }
  if (drawer.type === 'run') {
    const r = await api(`/api/runs/${drawer.id}`);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.innerHTML = `${close}<h1>${esc(r.roleName)}</h1>
      <p class="muted">${esc(r.purpose || '')}</p>
      <p><span class="pill ${r.live ? 'leaf' : r.status === 'parked' ? 'attention' : r.status === 'failed' ? 'attention' : ''}">${esc(r.live ? 'running' : r.status)}</span>
        ${r.model ? ` <span class="model ${modelTier(r.model)}">${esc(r.model)}</span> <span class="muted small">${esc(r.model_why || '')}</span>` : ''}</p>
      <p class="small muted">Started ${when(r.started_at)}${r.ended_at ? `, took ${span(r.started_at, r.ended_at)}` : `, running ${span(r.started_at)}`}.
        ${tokens(r.input_tokens + r.output_tokens + r.cache_write)} tokens (+${tokens(r.cache_read)} cache reads)${r.cost_usd ? `, about $${r.cost_usd.toFixed(2)} at list price` : ''}.
        ${r.idea_id ? ` Idea <a href="#" data-idea="${r.idea_id}">#${r.idea_id}</a>.` : ''}</p>
      ${r.error ? `<p class="pill attention" style="white-space:normal">${esc(r.error)}</p>` : ''}
      ${r.live ? '<div class="rate"><button class="btn danger small" id="dStop">Stop this run</button></div>' : ''}
      ${r.result_text ? `<section><h3>Result</h3><p style="white-space:pre-wrap">${esc(r.result_text)}</p></section>` : ''}
      ${r.kind === 'factory' && !r.live ? `<section><h3>Rate this run</h3><div class="rate"><button class="btn" id="rGood">Good</button>
        <select id="rReason" style="width:auto">${Object.entries(r.redoReasons).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <button class="btn danger" id="rRedo">Redo</button></div>${r.rating ? `<p class="small muted">Rated ${esc(r.rating)}.</p>` : ''}</section>` : ''}
      <section><h3>Steps</h3><div class="timeline">${r.activity.map((a) => `<div><span class="ts">${hhmm(a.ts)}</span><span>${a.tool_name ? `<b>${esc(a.tool_name.replace(/^mcp__/, ''))}</b> ` : ''}${esc(a.summary)}</span></div>`).join('') || '<p class="muted">No steps recorded.</p>'}</div></section>`;
    if (r.live && atBottom) el.scrollTop = el.scrollHeight;
    $('#dClose').addEventListener('click', closeDrawer);
    wireIdeaLinks(el);
    $('#dStop')?.addEventListener('click', () => { if (confirm('Stop this run? Its tools are released and the idea stays where it is.')) act(() => api(`/api/runs/${r.id}/stop`, {}), 'Stopped'); });
    $('#rGood')?.addEventListener('click', () => act(() => api(`/api/runs/${r.id}/rate`, { verdict: 'good' }), 'Thanks, noted'));
    $('#rRedo')?.addEventListener('click', () => act(() => api(`/api/runs/${r.id}/rate`, { verdict: 'redo', reason: $('#rReason').value }), (x) => (x.bumped ? `${x.bumped.taskType} now uses ${x.bumped.to}` : 'Noted')));
  }
}

// ---------- shell: routing, sidebar, live updates ----------
let current = null;
function route() {
  const [name, sub] = (location.hash.slice(1) || 'home').split('/');
  const page = pages[name] ? name : 'home';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === page));
  if (current !== `${page}/${sub || ''}`) { current = `${page}/${sub || ''}`; pages[page].mount(sub); }
  refresh();
}
async function refreshSidebar(home) {
  const n = home.needsYou.length + home.proposals.length;
  const needs = $('#navNeeds'); needs.hidden = !n; needs.textContent = n;
  const w = home.working.filter((r) => r.kind === 'factory').length;
  const working = $('#navWorking'); working.hidden = !w; working.textContent = w;
  const t = home.totals;
  const pct = Math.min(100, Math.round((t.tokensToday / t.budget) * 100));
  $('#budget').className = `budget${t.budgetReached ? ' full' : ''}`;
  $('#budget').innerHTML = `${t.budgetReached ? 'Daily token budget reached' : `${tokens(t.tokensToday)} of ${tokens(t.budget)} tokens today`}<div class="bar"><i style="width:${pct}%"></i></div>`;
  $('#pauseToggle').checked = t.paused;
  document.title = n ? `(${n}) Cat Tower Factory` : 'Cat Tower Factory';
}
let refreshing = false;
let again = false;
async function refresh() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    const home = await api('/api/home');
    await refreshSidebar(home);
    const page = current.split('/')[0];
    await pages[page].refresh(page === 'home' ? home : undefined);
    if (drawer && drawer.type !== 'new-idea') await renderDrawer();
  } catch (e) {
    console.error(e);
  } finally {
    refreshing = false;
    if (again) { again = false; refresh(); }
  }
}
let soon;
function refreshSoon() { clearTimeout(soon); soon = setTimeout(refresh, 250); }

$('#newIdeaBtn').addEventListener('click', () => openDrawer('new-idea'));
$('#pauseToggle').addEventListener('change', (e) => act(() => api('/api/settings', { paused: e.target.checked }), e.target.checked ? 'Factory paused' : 'Factory running'));
window.addEventListener('hashchange', route);

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => { $('#conn').textContent = 'Live'; $('#conn').className = 'conn'; refreshSoon(); });
  es.addEventListener('change', refreshSoon);
  es.onerror = () => { $('#conn').textContent = 'Factory offline. Retrying…'; $('#conn').className = 'conn off'; };
}
route();
connect();
setInterval(refreshSoon, 30_000); // keeps "x min ago" fresh
