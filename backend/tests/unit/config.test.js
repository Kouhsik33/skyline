import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';

// Merged config (src/config/index.js): OD defaults behind one variable each; invalid env and
// production without SESSION_SECRET stop the process; dev tools never on in production.
const run = (env, code) =>
  promisify(execFile)(process.execPath, ['--input-type=module', '-e', code ?? "import('./src/config/index.js').then(m => console.log(JSON.stringify({ dev: m.config.devToolsEnabled })))"], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://u:p@localhost:5432/x', ...env },
  });

describe('config', () => {
  it('documented defaults; each OD default behind one variable', () => {
    expect(config.PRICING_COMBINATION_MODE).toBe('BEST_OF'); // OD-01
    expect(config.RESERVATION_HOLD_MINUTES).toBe(15); // ASM-13
    expect(config.FUNDRAISER_AT_RISK_TOLERANCE_PCT).toBe(20);
    expect(config.AUTOPAY_PENDING_TIMEOUT_HOURS).toBe(24);
    expect(config.DEFAULT_LOW_STOCK_THRESHOLD).toBe(5);
    expect(config.RATE_LIMIT_ENABLED).toBe(false); // tests only (setup.js)
  });

  it('invalid values stop the process with the field named', async () => {
    await expect(run({ PRICING_COMBINATION_MODE: 'SUM' })).rejects.toMatchObject({ stderr: expect.stringMatching(/PRICING_COMBINATION_MODE/) });
  });

  it('production requires SESSION_SECRET and never enables dev tools', async () => {
    await expect(run({ NODE_ENV: 'production' })).rejects.toMatchObject({ stderr: expect.stringMatching(/SESSION_SECRET/) });
    const { stdout } = await run({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), DEV_TOOLS_ENABLED: 'true' });
    expect(JSON.parse(stdout.trim().split('\n').pop())).toEqual({ dev: false });
  });

  it('session cookie Secure: off for local HTTP in dev, on in production, overridable (B6)', async () => {
    const code = "import('./src/config/index.js').then(m => console.log(JSON.stringify({ secure: m.config.sessionCookieSecure })))";
    const secure = async (env) => JSON.parse((await run(env, code)).stdout.trim().split('\n').pop()).secure;
    expect(await secure({ NODE_ENV: 'development' })).toBe(false);
    expect(await secure({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) })).toBe(true);
    expect(await secure({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), SESSION_COOKIE_SECURE: 'false' })).toBe(false);
  });
});
