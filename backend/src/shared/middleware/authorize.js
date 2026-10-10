import { AppError } from '../errors.js';

/**
 * @param {ReturnType<import('../../modules/clubs/authz.js').createClubAuthz>} authz
 * @param {object} spec
 * @param {'AUTH'|'CH'|'TR'|'VOL'|'TEAM'|'ORG'|'STAFF'|'OWNER'} spec.role
 * @param {(req: import('express').Request) => Promise<{ clubId?: string, eventId?: string, ownerUserId?: string }>} spec.resolveScope
 */
function hasStanding(caps, clubId, eventId) {
  if (clubId && caps.clubRoles.some((r) => r.clubId === clubId)) return true;
  if (eventId && (caps.organizerOf.includes(eventId) || caps.staffOf.includes(eventId))) return true;
  return false;
}

export function authorize(authz, spec) {
  return async (req, _res, next) => {
    try {
      const userId = req.userId;
      if (!userId) {
        return next(new AppError('UNAUTHENTICATED', 401, 'Authentication required'));
      }
      const scope = await spec.resolveScope(req);
      const caps = await authz.getCapabilities(userId);

      // Not the owner: the resource does not exist for the caller (LLD §4.0 "not owned → 404").
      if (spec.role === 'OWNER') {
        if (scope.ownerUserId !== userId) {
          return next(new AppError('NOT_FOUND', 404, 'Not found'));
        }
        return next();
      }

      const { clubId, eventId } = scope;
      const allowed = await authz.checkRole(userId, spec.role, { clubId, eventId, caps });
      if (!allowed) {
        // Same rule as Group 2 (shared/access.js): some standing in the club → 403; none (another
        // club, or the club/event does not exist) → 404, so outsiders cannot enumerate (LLD §4.0).
        return next(hasStanding(caps, clubId, eventId) ? new AppError('FORBIDDEN', 403, 'Forbidden') : new AppError('NOT_FOUND', 404, 'Not found'));
      }
      req.capabilities = caps;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
