import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Money is BIGINT paise with integer arithmetic only (ADR-008). This grep test is the lint rule:
// no float parsing/rounding anywhere in src/, and no fractional SQL types in migrations.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
  });
}

const FLOAT_JS = [/parseFloat\s*\(/, /\.toFixed\s*\(/, /Math\.(round|floor|ceil|trunc)\s*\(/, /Number\.EPSILON/];
const FLOAT_SQL = [/\b(numeric|decimal|real|float[48]?|double\s+precision|money)\b/i, /\.(decimal|float|double)\s*\(/];

describe('no floating-point money', () => {
  it('src/ has no float parsing or rounding', () => {
    const offenders = [];
    for (const file of files(path.join(root, 'src'))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.trim().startsWith('//')) return;
          if (FLOAT_JS.some((re) => re.test(line))) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('migrations use no fractional column types', () => {
    const sources = files(path.join(root, 'src/db/migrations'));
    const offenders = [];
    for (const file of sources) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(--|\/\/)/.test(line)) return;
          if (FLOAT_SQL.some((re) => re.test(line))) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
