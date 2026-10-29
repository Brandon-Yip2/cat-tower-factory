// Opening the project's desktop apps (Roblox Studio on the Cat Tower place, Blender) for agents.
// Only the apps defined in guards.json (owner-only) can be launched, never a second copy, and
// the caller must be able to claim the app's tool lock first.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { REPO_ROOT } from './paths.mjs';
import { claim } from './resources.mjs';
import { describeHolder } from './snapshot.mjs';
import { logActivity } from './db.mjs';
import { studioWait } from './hookcore.mjs';

export function isRunning(processName) {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${processName}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').toLowerCase().includes(`"${processName.toLowerCase()}"`);
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(800, () => done(false));
  });
}

// Newest installed Studio build.
export function studioExe(env = process.env) {
  const root = path.join(env.LOCALAPPDATA || '', 'Roblox', 'Versions');
  let best = null;
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const exe = path.join(root, d, 'RobloxStudioBeta.exe');
    if (fs.existsSync(exe)) {
      const t = fs.statSync(exe).mtimeMs;
      if (!best || t > best.t) best = { exe, t };
    }
  }
  return best?.exe || null;
}

export function launchCommand(app, { file } = {}) {
  if (app.studioPlace) {
    const exe = studioExe();
    if (!exe) throw new Error('Roblox Studio is not installed (no RobloxStudioBeta.exe under %LOCALAPPDATA%\\Roblox\\Versions).');
    const p = app.studioPlace;
    return { exe, args: [`roblox-studio:1+launchmode:edit+task:EditPlace+placeId:${p.placeId}+universeId:${p.universeId}`] };
  }
  if (!app.exe || !fs.existsSync(app.exe)) throw new Error(`${app.name} is not installed at ${app.exe}.`);
  const args = [];
  if (file) {
    const full = path.resolve(REPO_ROOT, file);
    const under = path.resolve(REPO_ROOT, app.filesUnder || '');
    if (!full.startsWith(under + path.sep) || !full.toLowerCase().endsWith('.blend') || !fs.existsSync(full)) {
      throw new Error(`file must be an existing .blend under ${app.filesUnder} (got "${file}").`);
    }
    args.push(full);
  }
  return { exe: app.exe, args };
}

// Cached briefly: the dashboard asks on every refresh and tasklist takes ~100 ms.
let statusCache = { at: 0, value: null };
export function appStatus(cfg) {
  if (statusCache.value && Date.now() - statusCache.at < 5000) return statusCache.value;
  const value = Object.entries(cfg.guards.apps || {}).map(([id, app]) => ({ id, name: app.name, resource: app.resource, running: isRunning(app.process) }));
  statusCache = { at: Date.now(), value };
  return value;
}

// who: identity of the caller (factory run or interactive session). Returns a plain-language result.
export async function openApp(db, cfg, appId, who, { file = null, wait = true, claimLock = true } = {}) {
  const app = (cfg.guards.apps || {})[appId];
  if (!app) throw new Error(`unknown app "${appId}"; available: ${Object.keys(cfg.guards.apps || {}).join(', ')}`);
  const waiting = studioWait(db, who, app.resource);
  if (waiting) throw new Error(`Idea #${who.ideaId} may not use Roblox Studio until ${waiting} ships. Prepare without Studio, then update_idea status "staged".`);
  const res = !claimLock ? { ok: true } : claim(db, cfg, app.resource, {
    key: who.key, kind: who.kind, runId: who.kind === 'factory' ? who.runId : null, sessionId: who.sessionId,
    role: who.role, reason: `opening ${app.name}`, ideaId: who.ideaId,
  });
  if (!res.ok && who.kind !== 'interactive') {
    const h = res.holders[0];
    throw new Error(`${app.name} is in use: ${h ? describeHolder(cfg, h) : 'reserved for the queue head'}. You are #${res.position} in its queue.`);
  }
  if (isRunning(app.process)) {
    return `${app.name} is already open${app.studioPlace ? '; check that it shows the Cat Tower place with get_studio_state' : ''}.${claimLock ? ' You hold its lock.' : ''}`;
  }
  const { exe, args } = launchCommand(app, { file });
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  logActivity(db, { runId: who.runId, sessionId: who.sessionId, role: who.role, kind: 'gate', summary: `opened ${app.name}${file ? ` with ${file}` : ''}` });
  if (!wait) return `${app.name} is starting.`;
  const deadline = Date.now() + 45_000;
  if (app.readyPort) {
    while (Date.now() < deadline) {
      if (await portOpen(app.readyPort)) return `${app.name} is open and its MCP server is listening (port ${app.readyPort}). You hold its lock; release_tool when done.`;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return `${app.name} started but its MCP server is not listening yet; try a blender tool again in a minute.`;
  }
  while (Date.now() < deadline && !isRunning(app.process)) await new Promise((r) => setTimeout(r, 1500));
  return `${app.name} is starting on the ${app.studioPlace?.title || ''} place. Loading takes about a minute: call `
    + 'list_roblox_studios / get_studio_state until it shows the place, then continue. You hold its lock; release_tool when done '
    + '(leave Studio open and in Edit mode — never close it with unsaved changes).';
}
