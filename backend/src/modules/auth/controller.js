import { regenerateSession, SESSION_COOKIE_NAME, sessionCookieOptions } from '../../shared/middleware/session.js';

export function createAuthController({ authService }) {
  return {
    async register(req, res) {
      const user = await authService.register(req.body, req.requestId);
      req.session.userId = user.id;
      res.status(201).json({ data: user });
    },

    async login(req, res) {
      const user = await authService.login(req.body.email, req.body.password);
      await regenerateSession(req);
      req.session.userId = user.id;
      const me = await authService.getMe(user.id);
      res.json({ data: me });
    },

    async logout(req, res) {
      await new Promise((resolve, reject) => {
        req.session.destroy((err) => (err ? reject(err) : resolve()));
      });
      res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
      res.status(204).send();
    },

    async me(req, res) {
      const me = await authService.getMe(req.userId);
      res.json({ data: me });
    },

    async updateProfile(req, res) {
      const user = await authService.updateProfile(req.userId, req.body);
      res.json({ data: user });
    },

    async submitVerification(req, res) {
      const result = await authService.submitCollegeVerification(req.userId, req.body, req.requestId);
      res.json({ data: result });
    },

    async getVerification(req, res) {
      const result = await authService.getCollegeVerificationStatus(req.userId);
      res.json({ data: result });
    },
  };
}
