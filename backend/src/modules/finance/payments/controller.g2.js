import { pageResponse } from '../../../shared/pagination.js';
import { toPaymentDto } from './dto.js';

// HTTP adapters only: read validated input, call one service method, shape JSON.

export function createPaymentController({ payments }) {
  return Object.freeze({
    async get(req, res) {
      const payment = await payments.getForOwner(req.actor, req.valid.params.paymentId);
      res.json({ data: toPaymentDto(payment) });
    },

    async simulate(req, res) {
      const { payment, result } = await payments.simulate(req.actor, req.valid.params.paymentId, req.valid.body.outcome);
      res.json({ data: { ...toPaymentDto(payment), result } });
    },

    async devSimulate(req, res) {
      const { payment, result } = await payments.simulate(req.actor, req.valid.params.paymentId, req.valid.body.outcome, {
        devOverride: true,
      });
      res.json({ data: { ...toPaymentDto(payment), result } });
    },

    async listMine(req, res) {
      const { rows, total } = await payments.listMine(req.actor, req.valid.query);
      res.json(pageResponse(rows.map(toPaymentDto), req.valid.query, total));
    },

    async listForClub(req, res) {
      const { rows, total } = await payments.listForClub(req.valid.params.clubId, req.valid.query);
      res.json(pageResponse(rows.map(toPaymentDto), req.valid.query, total));
    },
  });
}
