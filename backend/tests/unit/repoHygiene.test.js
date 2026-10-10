import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A4 — merge leftovers are gone: the Group 1 fixture switch (GROUP1_SCHEMA) is not set by Compose
// and not referenced by code; the entrypoint describes what it does (migrate, then seed in dev).

const root = path.resolve('.');
function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (n === 'node_modules') return [];
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('repo hygiene after the merge (A4)', () => {
  it('Compose no longer sets GROUP1_SCHEMA in the backend container', () => {
    expect(process.env.GROUP1_SCHEMA).toBeUndefined();
  });

  it('no source, test or config file references GROUP1_SCHEMA or the deleted fixture switch', () => {
    const offenders = [...files(path.join(root, 'src')), ...files(path.join(root, 'tests')), path.join(root, 'knexfile.js')]
      .filter((f) => !f.endsWith('repoHygiene.test.js'))
      .filter((f) => /GROUP1_SCHEMA|group1_schema\.sql|migrationSource/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the entrypoint comment matches its behaviour (migrate, then idempotent seed in dev)', () => {
    const entry = readFileSync(path.join(root, 'docker-entrypoint.sh'), 'utf8');
    expect(entry).not.toMatch(/Seeds are not run yet/);
    expect(entry).toMatch(/knex migrate:latest/);
    expect(entry).toMatch(/SEED_ON_START/);
  });
});
