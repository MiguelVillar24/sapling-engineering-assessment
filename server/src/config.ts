import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walks up from this file to the repo root (the folder that holds data/alex_morgan.json). */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'data', 'alex_morgan.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('Could not locate the repo root (expected data/alex_morgan.json above the server folder)');
}

const root = findRepoRoot();

export const appConfig = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: resolve(process.env.DATA_DIR ?? join(root, 'data')),
  dbPath: process.env.DB_PATH === ':memory:' ? ':memory:' : resolve(process.env.DB_PATH ?? join(root, 'server', 'var', 'sapling.db')),
  webDist: resolve(process.env.WEB_DIST ?? join(root, 'web', 'dist')),
  scenarioNow: process.env.SCENARIO_NOW,
  repoRoot: root,
};
