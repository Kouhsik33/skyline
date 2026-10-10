import '../../loadEnv.js';
import { z } from 'zod';

if (!process.env.COLLEGE_EMAIL_DOMAINS && process.env.REGISTRATION_EMAIL_DOMAINS) {
  process.env.COLLEGE_EMAIL_DOMAINS = process.env.REGISTRATION_EMAIL_DOMAINS;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(1).optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  UPLOAD_DIR: z.string().default('/app/uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5242880),
  RESERVATION_HOLD_MINUTES: z.coerce.number().default(15),
  AUTOPAY_PENDING_TIMEOUT_HOURS: z.coerce.number().default(24),
  PRICING_COMBINATION_MODE: z.enum(['BEST_OF', 'STACK']).default('BEST_OF'),
  /** Comma-separated college email domains (register + roster check, not a signup blocklist). */
  COLLEGE_EMAIL_DOMAINS: z
    .string()
    .default('skyline.ac.in')
    .transform((v) =>
      v
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  COLLEGE_VERIFICATION_MODE: z.enum(['mock', 'unconfigured']).default('mock'),
  VERIFICATION_HASH_KEY: z.string().min(8).default('dev-key-change-me'),
  NOTIFY_MODE: z.enum(['dev', 'unconfigured']).default('dev'),
  DEV_NOTIFY_FAIL_CHANNEL: z.string().optional(),
  SIM_AUTOPAY_OUTCOME: z.enum(['SUCCEEDED', 'FAILED', 'PENDING']).default('SUCCEEDED'),
  DEV_TOOLS_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  SEED_ON_START: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  JOBS_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  FUNDRAISER_AT_RISK_TOLERANCE_PCT: z.coerce.number().default(20),
  DEFAULT_LOW_STOCK_THRESHOLD: z.coerce.number().int().min(0).default(5),
  /** false only in tests: the authorization matrices send far more than 300 requests a minute. */
  RATE_LIMIT_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  /** Session cookie Secure flag. Unset = true only in production; local HTTP needs false (B6). */
  SESSION_COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  /** Express 'trust proxy' (hop count) when the API sits behind the frontend nginx. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

if (env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is required in production');
  process.exit(1);
}

export const config = {
  ...env,
  sessionSecret: process.env.SESSION_SECRET || 'dev-session-secret-not-for-production',
  isProduction: env.NODE_ENV === 'production',
  sessionCookieSecure:
    env.SESSION_COOKIE_SECURE != null ? env.SESSION_COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  devToolsEnabled: env.DEV_TOOLS_ENABLED && env.NODE_ENV !== 'production',
  fundraiserAtRiskTolerancePct: env.FUNDRAISER_AT_RISK_TOLERANCE_PCT,
};
