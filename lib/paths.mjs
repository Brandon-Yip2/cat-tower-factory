// Where the Factory keeps things. Everything resolves from this file's location, so the
// daemon always works on the checkout it was installed from.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FACTORY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(FACTORY_DIR, '..');
export const DATA_DIR = process.env.FACTORY_DATA_DIR || path.join(FACTORY_DIR, 'data');
export const DB_PATH = process.env.FACTORY_DB || path.join(DATA_DIR, 'factory.db');
export const CONFIG_PATH = process.env.FACTORY_CONFIG || path.join(FACTORY_DIR, 'factory.config.json');
export const GUARDS_PATH = process.env.FACTORY_GUARDS || path.join(FACTORY_DIR, 'guards.json');
export const SECRET_PATH = path.join(DATA_DIR, 'secret');
export const PROMPTS_DIR = path.join(FACTORY_DIR, 'prompts');
export const UI_DIR = path.join(FACTORY_DIR, 'ui');
export const MCP_CONFIG_PATH = path.join(FACTORY_DIR, 'mcp', 'mcp.json');
