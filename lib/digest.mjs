// Compact digest of recent Factory activity for the self-review loop. Built from the DB so
// the Factory Engineer never has to read raw transcripts in bulk.
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const minutes = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 60_000 : 0);

export function buildDigest(db, cfg, { days = 3 } = {}) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const runs = db.prepare('SELECT * FROM runs WHERE started_at >= ?').all(since);
  const factory = runs.filter((r) => r.kind === 'factory');
  const out = [`# Factory digest — last ${days} day(s) (since ${since.slice(0, 16)})`];
  const billable = (r) => r.input_tokens + r.output_tokens + r.cache_write;
  const total = runs.reduce((s, r) => s + billable(r), 0);
  const shipped = db.prepare("SELECT COUNT(*) n FROM ideas WHERE shipped_at >= ?").get(since).n;
  out.push(`Runs: ${factory.length} factory, ${runs.length - factory.length} interactive · billable tokens ${k(total)} · est. cost $${runs.reduce((s, r) => s + r.cost_usd, 0).toFixed(2)} · ideas shipped ${shipped}${shipped ? ` · ${k(Math.round(total / shipped))} tokens per shipped idea` : ''}`);

  out.push('\n## By role and model');
  const groups = new Map();
  for (const r of factory) {
    const key = `${r.role} · ${r.model || '?'}`;
    const g = groups.get(key) || { n: 0, tok: 0, min: 0, failed: 0, redo: 0, rated: 0 };
    g.n += 1; g.tok += billable(r); g.min += minutes(r.started_at, r.ended_at || r.last_activity_at);
    if (['failed', 'stopped'].includes(r.status)) g.failed += 1;
    if (r.rating) g.rated += 1;
    if (r.rating === 'redo') g.redo += 1;
    groups.set(key, g);
  }
  for (const [key, g] of [...groups].sort((a, b) => b[1].tok - a[1].tok)) {
    out.push(`- ${key}: ${g.n} runs, avg ${k(Math.round(g.tok / g.n))} tokens, avg ${Math.round(g.min / g.n)} min, failed ${g.failed}, redo ${g.redo}/${g.rated} rated`);
  }

  const redos = db.prepare(`SELECT r.task_type, r.model, r.redo_reason, r.rating_note, r.role FROM runs r
    WHERE r.rating = 'redo' AND r.started_at >= ?`).all(since);
  if (redos.length) {
    out.push('\n## Owner redo reviews');
    for (const r of redos) out.push(`- ${r.role} (${r.task_type || '?'} on ${r.model}): ${r.redo_reason || 'no reason'}${r.rating_note ? ` — "${r.rating_note}"` : ''}`);
  }

  const gates = db.prepare(`SELECT role, summary FROM activity WHERE kind = 'gate' AND summary LIKE 'denied%' AND ts >= ?`).all(since);
  if (gates.length) {
    const byKey = new Map();
    for (const g of gates) { const key = `${g.role}: ${g.summary.split(':')[0]}`; byKey.set(key, (byKey.get(key) || 0) + 1); }
    out.push('\n## Tool-gate denials');
    for (const [key, n] of [...byKey].sort((a, b) => b[1] - a[1]).slice(0, 8)) out.push(`- ${key} ×${n}`);
  }

  const fails = db.prepare(`SELECT tool_name, summary, COUNT(*) n FROM activity WHERE summary LIKE '✗%' AND ts >= ?
    GROUP BY tool_name, summary ORDER BY n DESC LIMIT 10`).all(since);
  if (fails.length) {
    out.push('\n## Repeated failing tool calls');
    for (const f of fails) out.push(`- ${f.tool_name} ×${f.n}: ${f.summary.slice(2, 140)}`);
  }

  const longest = [...factory].sort((a, b) => minutes(b.started_at, b.ended_at) - minutes(a.started_at, a.ended_at)).slice(0, 5);
  if (longest.length) {
    out.push('\n## Longest runs');
    for (const r of longest) out.push(`- ${r.id} ${r.role} ${Math.round(minutes(r.started_at, r.ended_at || r.last_activity_at))} min, ${k(billable(r))} tokens: ${(r.purpose || '').slice(0, 90)}`);
  }

  // Long silent gaps inside runs usually mean waiting on Studio, a slow command, or confusion.
  const gaps = [];
  for (const r of factory.slice(-60)) {
    const ts = db.prepare('SELECT ts, summary FROM activity WHERE run_id = ? ORDER BY id').all(r.id);
    for (let i = 1; i < ts.length; i += 1) {
      const gap = minutes(ts[i - 1].ts, ts[i].ts);
      if (gap >= 5) gaps.push({ run: r.id, role: r.role, gap, before: ts[i - 1].summary });
    }
  }
  if (gaps.length) {
    out.push('\n## Long gaps (≥5 min between tool calls)');
    for (const g of gaps.sort((a, b) => b.gap - a.gap).slice(0, 6)) out.push(`- ${g.role} ${g.run}: ${Math.round(g.gap)} min after "${g.before.slice(0, 90)}"`);
  }

  const rework = db.prepare(`SELECT id, title, rework_count FROM ideas WHERE rework_count > 0 AND updated_at >= ? ORDER BY rework_count DESC LIMIT 5`).all(since);
  if (rework.length) {
    out.push('\n## Ideas sent back by QA');
    for (const i of rework) out.push(`- #${i.id} ${i.title}: ${i.rework_count} rework(s)`);
  }

  const qs = db.prepare(`SELECT created_at, answered_at, status FROM questions WHERE created_at >= ? AND kind = 'question'`).all(since);
  if (qs.length) {
    const answered = qs.filter((q) => q.answered_at);
    const avg = answered.length ? answered.reduce((s, q) => s + minutes(q.created_at, q.answered_at), 0) / answered.length : 0;
    out.push(`\n## Questions to owner: ${qs.length} asked, ${answered.length} answered, avg wait ${Math.round(avg)} min`);
  }
  const overrides = db.prepare('SELECT * FROM routing_overrides').all();
  if (overrides.length) {
    out.push('\n## Routing overrides in force');
    for (const o of overrides) out.push(`- ${o.task_type} → ${o.model} (${o.source}): ${o.why}`);
  }
  return out.join('\n');
}
