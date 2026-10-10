import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { config } from '../../config/index.js';

// RATE_LIMIT_ENABLED=false (tests only) turns both limiters off.
const skip = () => !config.RATE_LIMIT_ENABLED;

export const globalRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  skip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
});

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skip,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body?.email || ''}`,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts' } },
});
