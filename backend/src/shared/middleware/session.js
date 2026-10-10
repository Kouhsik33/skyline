import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from '../../config/index.js';

const PgSession = connectPgSimple(session);

export const SESSION_COOKIE_NAME = 'sid';

/** One source for the cookie flags, so logout clears exactly the cookie login set. */
export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: config.sessionCookieSecure, path: '/' };
}

export function createSessionMiddleware() {
  return session({
    store: new PgSession({
      conObject: {
        connectionString: config.DATABASE_URL,
      },
      tableName: 'user_sessions',
      createTableIfMissing: false,
    }),
    name: SESSION_COOKIE_NAME,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      ...sessionCookieOptions(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

/** @param {import('express').Request} req */
export function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    const prev = { ...req.session };
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, prev);
      resolve();
    });
  });
}
