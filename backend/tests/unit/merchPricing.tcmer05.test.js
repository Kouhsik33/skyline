import { describe, expect, it } from 'vitest';
import { quoteMerchItem } from '../../src/modules/pricing/index.js';

// TC-MER-05 — member merch discount + offer, against the REAL pricing module (LLD §2.6):
//   memDisc   = benefits && memberDiscountEligible ? half-up(price × bps) : 0
//   regular   = price − memDisc                    (rule MEMBER_DISCOUNT if memDisc > 0, else LIST)
//   offer ok  = offerStartsAt ≤ now ≤ offerEndsAt
//   offerDisc = (STACK && benefits && eligible) ? half-up(offer × bps) : 0
//   offerFinal= offer − offerDisc; offer wins only if offerFinal ≤ regular
//               (rule OFFER, or OFFER_PLUS_MEMBER when stacked) — never charge more for an "offer".
// Hand-computed values: price ₹500 (50 000 paise), member 10 % (1000 bps), offer ₹420 (42 000).

const now = new Date('2026-11-01T10:00:00+05:30');
const window = { offerStartsAt: '2026-10-25T00:00:00Z', offerEndsAt: '2026-11-10T00:00:00Z' };
const product = (extra = {}) => ({ pricePaise: 50000, memberDiscountEligible: true, availableToNonMembers: true, offerPricePaise: null, offerStartsAt: null, offerEndsAt: null, ...extra });
const member = { merchDiscountBps: 1000 };
const q = (p, b, mode = 'BEST_OF', at = now) => quoteMerchItem(p, b, at, { mode });
const quote = (listPricePaise, discountPaise, finalPricePaise, priceRule) => ({ listPricePaise, discountPaise, finalPricePaise, priceRule });

describe('TC-MER-05 merchandise pricing (real PricingPolicy, LLD §2.6)', () => {
  it.each([
    ['non-member, no offer → LIST', product(), null, 'BEST_OF', quote(50000, 0, 50000, 'LIST')],
    ['member, no offer → MEMBER_DISCOUNT 10 %', product(), member, 'BEST_OF', quote(50000, 5000, 45000, 'MEMBER_DISCOUNT')],
    ['member, product not discount-eligible → LIST', product({ memberDiscountEligible: false }), member, 'BEST_OF', quote(50000, 0, 50000, 'LIST')],
    ['non-member, offer active → OFFER', product({ offerPricePaise: 42000, ...window }), null, 'BEST_OF', quote(42000, 0, 42000, 'OFFER')],
    ['member, BEST_OF, offer 420 < member 450 → OFFER without the discount', product({ offerPricePaise: 42000, ...window }), member, 'BEST_OF', quote(42000, 0, 42000, 'OFFER')],
    ['member, STACK, offer + 10 % → OFFER_PLUS_MEMBER 378', product({ offerPricePaise: 42000, ...window }), member, 'STACK', quote(42000, 4200, 37800, 'OFFER_PLUS_MEMBER')],
    ['member, BEST_OF, offer 480 > member 450 → MEMBER_DISCOUNT (never charge more)', product({ offerPricePaise: 48000, ...window }), member, 'BEST_OF', quote(50000, 5000, 45000, 'MEMBER_DISCOUNT')],
    ['member, STACK, offer 480 − 48 = 432 ≤ 450 → OFFER_PLUS_MEMBER', product({ offerPricePaise: 48000, ...window }), member, 'STACK', quote(48000, 4800, 43200, 'OFFER_PLUS_MEMBER')],
    ['non-member, STACK, offer → OFFER (no member discount)', product({ offerPricePaise: 42000, ...window }), null, 'STACK', quote(42000, 0, 42000, 'OFFER')],
    ['offer not yet started → regular price', product({ offerPricePaise: 42000, offerStartsAt: '2026-11-05T00:00:00Z', offerEndsAt: '2026-11-10T00:00:00Z' }), member, 'BEST_OF', quote(50000, 5000, 45000, 'MEMBER_DISCOUNT')],
    ['offer ended → regular price', product({ offerPricePaise: 42000, offerStartsAt: '2026-10-01T00:00:00Z', offerEndsAt: '2026-10-31T00:00:00Z' }), null, 'BEST_OF', quote(50000, 0, 50000, 'LIST')],
    ['half-up rounding once: 12 345 × 10 % = 1 234.5 → 1 235', product({ pricePaise: 12345 }), member, 'BEST_OF', quote(12345, 1235, 11110, 'MEMBER_DISCOUNT')],
  ])('%s', async (_name, p, benefits, mode, expected) => {
    expect(await q(p, benefits, mode)).toEqual(expected);
  });

  it('members-only product: non-member → MEMBERS_ONLY_PRODUCT; member is priced normally', async () => {
    await expect(q(product({ availableToNonMembers: false }), null)).rejects.toMatchObject({ code: 'MEMBERS_ONLY_PRODUCT' });
    expect(await q(product({ availableToNonMembers: false }), member)).toEqual(quote(50000, 5000, 45000, 'MEMBER_DISCOUNT'));
  });

  it('final = list − discount in every case; integer paise', async () => {
    for (const mode of ['BEST_OF', 'STACK']) {
      for (const b of [null, member]) {
        const r = await q(product({ offerPricePaise: 42000, ...window }), b, mode);
        expect(r.finalPricePaise).toBe(r.listPricePaise - r.discountPaise);
        expect(Number.isSafeInteger(r.finalPricePaise)).toBe(true);
      }
    }
  });
});
