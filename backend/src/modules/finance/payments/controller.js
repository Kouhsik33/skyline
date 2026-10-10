// Group 1 payment routes (GET /payments/:id, simulate, /me/payments). Responses are the payment
// row in camelCase plus `target` ({ type, id }, OQ-24); simulate adds `result` (null when there
// was no side effect: PENDING, terminal payment — OQ-13).

function withTarget(p) {
  const target = p.membershipTermId
    ? { type: 'MEMBERSHIP_TERM', id: p.membershipTermId }
    : p.bookingId
      ? { type: 'BOOKING', id: p.bookingId }
      : { type: 'ORDER', id: p.orderId };
  return { ...p, target };
}

export function createPaymentController({ paymentService }) {
  return {
    async getPayment(req, res) {
      const payment = await paymentService.getPayment(req.userId, req.params.paymentId);
      res.json({ data: withTarget(payment) });
    },

    async simulate(req, res) {
      const { payment, result } = await paymentService.simulate(req.userId, req.params.paymentId, req.body.outcome);
      res.json({ data: { ...withTarget(payment), result: result ?? null } });
    },

    async listMine(req, res) {
      const body = await paymentService.listMine(req.userId, req.valid.query);
      res.json({ ...body, data: body.data.map(withTarget) });
    },
  };
}
