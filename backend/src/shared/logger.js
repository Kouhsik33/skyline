import pino from 'pino';
import { config } from '../config/index.js';

// Structured logs with redaction (LLD §9; T-92): never passwords, session ids / cookies, student
// identifiers, QR tokens or phone numbers. pino wildcards match one level, so each key is listed
// at every depth we log objects (pino-http nests headers under req / res).
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'cookie',
  'authorization',
  'set-cookie',
  'studentIdentifier',
  'student_identifier',
  'qrPayload',
  'qrToken',
  'qr_token',
  'phoneE164',
  'phone_e164',
  'destination',
  'sid',
  'sessionId',
];

function redactPaths(keys, depth = 4) {
  const paths = [];
  for (const key of keys) {
    const k = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
    let prefix = '';
    for (let d = 0; d < depth; d += 1) {
      paths.push(prefix ? `${prefix}${k.startsWith('[') ? k : `.${k}`}` : k);
      prefix = prefix ? `${prefix}.*` : '*';
    }
  }
  return paths;
}

export const REDACT_PATHS = redactPaths(SENSITIVE_KEYS);

export function createLogger({ level = 'info', destination } = {}) {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, destination);
}

export const logger = createLogger({ level: process.env.LOG_LEVEL ?? (config.isTest ? 'silent' : 'info') });
