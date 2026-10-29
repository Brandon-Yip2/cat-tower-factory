// Shared test fixtures: an in-memory DB and the real config with default guards.
import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import { loadConfig } from '../lib/config.mjs';
import { FACTORY_DIR } from '../lib/paths.mjs';

export function fixture() {
  const db = openDb(':memory:');
  const cfg = loadConfig(path.join(FACTORY_DIR, 'factory.config.json'), path.join(FACTORY_DIR, 'guards.json'));
  return { db, cfg };
}
