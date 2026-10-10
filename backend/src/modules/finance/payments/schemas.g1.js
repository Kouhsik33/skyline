import { z } from 'zod';

// Strict: the client sends only the outcome; amount, status and is_simulated are never accepted.
export const simulatePaymentBody = z
  .object({
    outcome: z.enum(['SUCCEEDED', 'FAILED', 'PENDING']),
  })
  .strict();

export const paymentIdParam = z.object({
  paymentId: z.string().uuid(),
});
