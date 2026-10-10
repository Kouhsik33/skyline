import { applyBps } from '../../shared/money.js';
import { appError } from '../../shared/errors.js';

/**
 * quoteMerchItem(product, benefits | null, now, { mode }) — the only merchandise pricing (LLD §2.6,
 * OD-01 mode from PRICING_COMBINATION_MODE). Returns a per-unit quote, integer paise:
 *   { listPricePaise, discountPaise, finalPricePaise, priceRule }   final = list − discount
 *   - regular = price − member discount (MEMBER_DISCOUNT if any, else LIST)
 *   - an active offer wins only if it is not dearer than regular ("never charge more because of an
 *     offer"); in STACK mode the member discount also applies to the offer (OFFER_PLUS_MEMBER),
 *     in BEST_OF it does not (OFFER).
 * Corrected to LLD §2.6 by Group 2 during the merge (TC-MER-05): the previous version stacked the
 * member discount onto offers in BEST_OF mode and never produced OFFER_PLUS_MEMBER.
 */
export async function quoteMerchItem(product, benefits, now, { mode = 'BEST_OF' } = {}) {
  if (!benefits && !product.availableToNonMembers) {
    throw appError('MEMBERS_ONLY_PRODUCT');
  }
  const price = Number(product.pricePaise);
  const eligible = Boolean(benefits) && product.memberDiscountEligible !== false;
  const bps = eligible ? (benefits.merchDiscountBps ?? 0) : 0;

  const memberDisc = eligible ? applyBps(price, bps) : 0;
  const regular = { listPricePaise: price, discountPaise: memberDisc, finalPricePaise: price - memberDisc, priceRule: memberDisc > 0 ? 'MEMBER_DISCOUNT' : 'LIST' };

  const t = now.getTime();
  const offerActive =
    product.offerPricePaise != null &&
    product.offerStartsAt != null &&
    product.offerEndsAt != null &&
    new Date(product.offerStartsAt).getTime() <= t &&
    t <= new Date(product.offerEndsAt).getTime();
  if (!offerActive) return regular;

  const offer = Number(product.offerPricePaise);
  const stacked = mode === 'STACK' && eligible;
  const offerDisc = stacked ? applyBps(offer, bps) : 0;
  const offerQuote = {
    listPricePaise: offer,
    discountPaise: offerDisc,
    finalPricePaise: offer - offerDisc,
    priceRule: stacked && offerDisc > 0 ? 'OFFER_PLUS_MEMBER' : 'OFFER',
  };
  return offerQuote.finalPricePaise <= regular.finalPricePaise ? offerQuote : regular;
}

export { createPricingPolicy } from './PricingPolicy.js';
