export function createReportingController({ reporting }) {
  return Object.freeze({
    async membershipReport(req, res) {
      res.json({ data: await reporting.membershipReport(req.valid.params.clubId) });
    },
    async merchandiseReport(req, res) {
      res.json({ data: await reporting.merchandiseReport(req.valid.params.clubId) });
    },
    async financeReport(req, res) {
      res.json({ data: await reporting.financeReport(req.valid.params.clubId, req.valid.query) });
    },
  });
}
