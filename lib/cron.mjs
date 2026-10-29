// Minimal 5-field cron (minute hour day-of-month month day-of-week), local time.
// Supports *, numbers, lists (1,4), ranges (1-5) and steps (*/3, 1-10/2).

const FIELDS = [
  { name: 'min', lo: 0, hi: 59 },
  { name: 'hour', lo: 0, hi: 23 },
  { name: 'dom', lo: 1, hi: 31 },
  { name: 'mon', lo: 1, hi: 12 },
  { name: 'dow', lo: 0, hi: 6 },
];

function parseField(text, { lo, hi }) {
  const out = new Set();
  for (const part of text.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    let a, b;
    if (rangePart === '*') [a, b] = [lo, hi];
    else if (rangePart.includes('-')) [a, b] = rangePart.split('-').map(Number);
    else [a, b] = [Number(rangePart), stepPart ? hi : Number(rangePart)];
    if (![a, b, step].every(Number.isFinite) || step < 1) throw new Error(`bad cron field "${text}"`);
    for (let v = a; v <= b; v += step) {
      const val = v === 7 && hi === 6 ? 0 : v; // allow 7 = Sunday
      if (val < lo || val > hi) throw new Error(`cron value ${v} out of range in "${text}"`);
      out.add(val);
    }
  }
  return out;
}

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  const c = {};
  FIELDS.forEach((f, i) => { c[f.name] = parseField(parts[i], f); });
  c.domStar = parts[2] === '*';
  c.dowStar = parts[4] === '*';
  return c;
}

function dayMatches(c, d) {
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk; // classic cron: either restriction matches
}

// First matching minute strictly after `from`.
export function nextRun(expr, from = new Date()) {
  const c = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 400 * 86400_000;
  while (d.getTime() < limit) {
    if (!c.mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d;
  }
  throw new Error(`cron "${expr}" never fires`);
}

// Most recent matching minute at or before `at` (searching back `hours`), or null.
export function prevRun(expr, at = new Date(), hours = 48) {
  const start = new Date(at.getTime() - hours * 3600_000);
  let t = nextRun(expr, new Date(start.getTime() - 60_000));
  let last = null;
  while (t.getTime() <= at.getTime()) { last = t; t = nextRun(expr, t); }
  return last;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');

export function describeCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  const [min, hour, dom, mon, dow] = parts;
  const simpleTime = /^\d+$/.test(min) && /^\d+$/.test(hour);
  const at = simpleTime ? `at ${pad(hour)}:${pad(min)}` : `(${expr})`;
  if (mon !== '*') return `Cron ${expr}`;
  if (dom === '*' && dow === '*') return simpleTime ? `Daily ${at}` : `Cron ${expr}`;
  if (dom === '*' && /^[\d,]+$/.test(dow)) {
    const days = dow.split(',').map((d) => DAY[Number(d) % 7]);
    const list = days.length > 1 ? `${days.slice(0, -1).join(', ')} & ${days.at(-1)}` : days[0];
    return `${list} ${at}`;
  }
  const step = /^\*\/(\d+)$/.exec(dom);
  if (step && dow === '*') return `Every ${step[1]} days ${at}`;
  return `Cron ${expr}`;
}
