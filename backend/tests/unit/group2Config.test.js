import { describe, expect, it } from 'vitest';
import { toGroup2Config } from '../../src/integration/group1Bridge.js';
import { config } from '../../src/config/index.js';

// Every setting Group 2 reads must be mapped from the merged config (an unmapped value became
// undefined → NaN hold times → "Invalid Date" on every order).
describe('toGroup2Config', () => {
  it('maps every key Group 2 modules read, with the documented defaults', () => {
    const g2 = toGroup2Config(config);
    expect(g2).toMatchObject({
      timezone: 'Asia/Kolkata',
      reservationHoldMinutes: 15,
      autopayPendingTimeoutHours: 24,
      defaultLowStockThreshold: 5,
      pricingCombinationMode: 'BEST_OF',
      fundraiserAtRiskTolerancePct: 20,
      maxUploadBytes: 5242880,
      notifyMode: 'dev',
    });
    for (const key of ['timezone', 'uploadDir', 'maxUploadBytes', 'reservationHoldMinutes', 'autopayPendingTimeoutHours', 'defaultLowStockThreshold', 'pricingCombinationMode', 'simAutopayOutcome', 'notifyMode', 'fundraiserAtRiskTolerancePct']) {
      expect(g2[key], key).not.toBeUndefined();
    }
  });
});
