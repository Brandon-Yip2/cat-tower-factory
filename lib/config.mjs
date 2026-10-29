// Factory as code: factory.config.json (roles, resources, loops, routing — agents may edit)
// plus guards.json (safety limits — owner only).
import fs from 'node:fs';
import { CONFIG_PATH, GUARDS_PATH } from './paths.mjs';

const GUARD_DEFAULTS = {
  maxConcurrentRuns: 3,
  dailyTokenBudget: 60_000_000,
  maxRunsPerIdea: 10,
  maxRework: 3,
  idleReleaseMinutes: 10,
  studioIdleMinutes: 30,
  catchUpHours: 12,
  runCapUsd: { haiku: 8, sonnet: 8, opus: 20 },
  approval: { ownerIdeasAutoApproved: true, agentFeaturesWithoutParentNeedOwner: true },
  learning: { window: 5, modelRedosToBump: 2, tiers: ['haiku', 'sonnet', 'opus'] },
  protectedPaths: [],
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

export function loadConfig(configPath = CONFIG_PATH, guardsPath = GUARDS_PATH) {
  const cfg = readJson(configPath);
  cfg.settings = { port: 4477, currentPass: '', claudePath: '', triageBatch: 8, ...(cfg.settings || {}) };
  cfg.roles ||= [];
  cfg.resources ||= [];
  cfg.loops ||= [];
  cfg.routing ||= {};
  cfg.areas ||= [];
  cfg.guards = { ...GUARD_DEFAULTS, ...readJson(guardsPath, {}) };
  return cfg;
}

export function roleById(cfg, id) {
  return cfg.roles.find((r) => r.id === id) || null;
}

// Agent type (e.g. "ct-qa-lead") → role id, for sessions identified by their agent definition.
export function roleByAgent(cfg, agentType) {
  if (!agentType) return null;
  return cfg.roles.find((r) => r.agent === agentType) || null;
}
