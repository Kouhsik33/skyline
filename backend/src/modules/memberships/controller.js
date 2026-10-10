import { toCamelCase } from '../../shared/caseMap.js';

export function createMembershipController({ membershipService, plansService }) {
  return {
    async listPlans(req, res) {
      const plans = await plansService.listPlans(req.userId, req.params.clubId, req.query);
      res.json({ data: plans.map((p) => toCamelCase(p)) });
    },

    async createPlan(req, res) {
      const plan = await plansService.createPlan(req.userId, req.params.clubId, req.body);
      res.status(201).json({ data: toCamelCase(plan) });
    },

    async register(req, res) {
      const result = await membershipService.register(
        { userId: req.userId },
        req.params.clubId,
        req.body.planId,
        req.body.expectedFeePaise,
      );
      res.status(201).json({ data: result });
    },

    async renew(req, res) {
      const result = await membershipService.renew(
        { userId: req.userId },
        req.params.membershipId,
        req.body.planId,
        req.body.expectedFeePaise,
      );
      res.status(201).json({ data: result });
    },

    async listMine(req, res) {
      const list = await membershipService.listMine(req.userId);
      res.json({ data: list });
    },

    async digitalId(req, res) {
      const data = await membershipService.getDigitalId(req.userId, req.params.membershipId);
      res.json({ data });
    },

    async rotateDigitalId(req, res) {
      const data = await membershipService.rotateDigitalId(req.userId, req.params.membershipId);
      res.json({ data });
    },

    async verifyQr(req, res) {
      const data = await membershipService.verifyMembershipQr(req.userId, req.body.qrPayload, req.requestId);
      res.json({ data });
    },
  };
}
