import { createHash } from 'node:crypto';
import { appError } from '../errors.js';

// Idempotency-Key for [IDEM] routes (LLD §3.1 idempotency_keys, §4.0; OQ-23).
//  - Key is a UUID, scoped per user (PK user_id, key), kept 24 h.
//  - Same key + same method/path/body -> stored status + body replayed.
//  - Same key + different request     -> 409 IDEMPOTENCY_KEY_REUSED.
//  - Same key while the first is running -> 409 REQUEST_IN_PROGRESS; a lock older than 60 s is
//    treated as abandoned and retaken.
//  - 2xx and 4xx responses are stored; on 5xx the key is released so the client can retry.
// The response is persisted before it is sent, so a replay never observes "in progress" after
// the client has its answer. Must run after requireAuth (and after the multipart parser on
// upload routes) and before validation.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 24 * 60 * 60 * 1000;
const STALE_LOCK_MS = 60 * 1000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(method, path, body) {
  return createHash('sha256').update(`${method}\n${path}\n${canonical(body ?? {})}`).digest('hex');
}

export function createIdempotency({ db, clock, logger }) {
  async function claim(userId, key, method, path, hash) {
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + TTL_MS);
    const inserted = await db.raw(
      `INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, locked_at, expires_at)
       VALUES (:userId, :key, :method, :path, :hash, :now, :expiresAt)
       ON CONFLICT (user_id, key) DO NOTHING
       RETURNING key`,
      { userId, key, method, path, hash, now, expiresAt },
    );
    if (inserted.rows.length) return { state: 'claimed' };

    const existing = await db('idempotency_keys').where({ user_id: userId, key }).first();
    if (!existing) return claim(userId, key, method, path, hash); // released between our two statements
    if (existing.expires_at <= now) {
      await db('idempotency_keys').where({ user_id: userId, key }).andWhere('expires_at', '<=', now).del();
      return claim(userId, key, method, path, hash);
    }
    if (existing.request_hash !== hash) return { state: 'reused' };
    if (existing.status_code !== null) return { state: 'replay', row: existing };

    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const retaken = await db('idempotency_keys')
      .where({ user_id: userId, key })
      .whereNull('status_code')
      .andWhere('locked_at', '<', staleBefore)
      .update({ locked_at: now })
      .returning('key');
    return retaken.length ? { state: 'claimed' } : { state: 'in_progress' };
  }

  async function complete(userId, key, statusCode, body) {
    if (statusCode >= 500) {
      await db('idempotency_keys').where({ user_id: userId, key }).whereNull('status_code').del();
      return;
    }
    await db('idempotency_keys')
      .where({ user_id: userId, key })
      .update({ status_code: statusCode, response_body: JSON.stringify(body ?? null), locked_at: null });
  }

  return function idempotency() {
    return async (req, res, next) => {
      try {
        const key = req.get('Idempotency-Key');
        if (!key || !UUID.test(key)) throw appError('IDEMPOTENCY_KEY_REQUIRED');
        const userId = req.actor?.userId ?? req.userId;
        if (!userId) throw appError('UNAUTHENTICATED');
        const path = req.baseUrl + req.path;
        // Multipart: the uploaded file's SHA-256 is part of the request identity.
        const body = req.file
          ? { ...req.body, __file: { field: req.file.fieldname, sha256: createHash('sha256').update(req.file.buffer).digest('hex') } }
          : req.body;
        const hash = requestHash(req.method, path, body);
        const outcome = await claim(userId, key.toLowerCase(), req.method, path, hash);

        if (outcome.state === 'reused') throw appError('IDEMPOTENCY_KEY_REUSED');
        if (outcome.state === 'in_progress') throw appError('REQUEST_IN_PROGRESS');
        if (outcome.state === 'replay') {
          res.set('Idempotent-Replayed', 'true');
          return res.status(outcome.row.status_code).json(outcome.row.response_body);
        }

        const send = res.json.bind(res);
        res.json = (body) => {
          complete(userId, key.toLowerCase(), res.statusCode, body)
            .catch((err) => logger.error({ requestId: req.requestId ?? req.id, err }, "idempotency: failed to store response"))
            .finally(() => send(body));
          return res;
        };
        next();
      } catch (err) {
        next(err);
      }
    };
  };
}
