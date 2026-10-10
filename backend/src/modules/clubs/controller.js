export function createClubController({ clubService }) {
  return {
    async list(req, res) {
      const result = await clubService.listClubs(req.valid?.query ?? req.query);
      res.json({ data: result.items, meta: { page: result.page, pageSize: result.pageSize } });
    },

    async get(req, res) {
      const club = await clubService.getClub(req.params.clubId);
      res.json({ data: club });
    },

    async listRoles(req, res) {
      const roles = await clubService.listRoles(req.userId, req.params.clubId);
      res.json({ data: roles });
    },

    async assignRole(req, res) {
      const assignment = await clubService.assignRole(req.userId, req.params.clubId, req.body, req.requestId);
      res.status(201).json({ data: assignment });
    },

    async revokeRole(req, res) {
      await clubService.revokeRole(req.userId, req.params.clubId, req.params.assignmentId, req.requestId);
      res.status(204).send();
    },
  };
}
