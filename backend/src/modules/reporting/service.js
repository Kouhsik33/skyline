import { LEDGER_CATEGORY_LIST } from './categories.js';
import * as repository from './repository.js';

// Reports (LLD §4.10). Step 4 delivers the finance report only (OQ-52 APPROVED): the §2.10 summary,
// the monthly series with net, and a per-category breakdown (amount and number of entries).
// The summary comes from the finance module's public API so the formulas live in one place.

import { addDays } from '../../shared/dates.js';

export function createReportingService({ db, financeSummary, timeZone, clock }) {
  async function financeReport(clubId, { from, to }) {
    const [summary, breakdown] = await Promise.all([
      financeSummary(clubId, { from, to }),
      repository.ledgerCategoryBreakdown(db, clubId, { from, to, timeZone }),
    ]);
    const byKey = new Map(breakdown.map((r) => [`${r.direction}:${r.category}`, r]));
    const categoryBreakdown = {};
    for (const [direction, categories] of Object.entries(LEDGER_CATEGORY_LIST)) {
      categoryBreakdown[direction] = categories.map((category) => {
        const r = byKey.get(`${direction}:${category}`);
        return { category, totalPaise: r?.total ?? 0, entries: r?.entries ?? 0 };
      });
    }
    const { monthly, ...metrics } = summary;
    return {
      ...metrics,
      monthly: monthly.map((m) => ({ ...m, netPaise: m.inPaise - m.outPaise })),
      categoryBreakdown,
    };
  }

  /** GET /clubs/:clubId/reports/memberships (T-85, LLD §4.10). */
  async function membershipReport(clubId) {
    const today = clock.todayIST();
    const [byPlan, months, dues, counts, attempts] = await Promise.all([
      repository.activeMembersByPlan(db, clubId, today),
      repository.termsPerMonth(db, clubId, timeZone),
      repository.duesCollected(db, clubId),
      repository.membershipCounts(db, clubId, today, addDays(today, 7)),
      repository.renewalAttemptsByStatus(db, clubId),
    ]);
    return {
      asOf: today,
      activeMembers: byPlan.reduce((n, r) => n + r.members, 0),
      activeMembersByPlan: byPlan.map((r) => ({ planId: r.plan_id, planName: r.plan_name, members: r.members })),
      joinsAndRenewalsByMonth: months,
      duesCollectedPaise: dues,
      expiringIn7Days: counts.expiring_in_7_days,
      autopayEnabled: counts.autopay_enabled,
      renewalAttempts: attempts.map((r) => ({ status: r.status, attempts: r.attempts })),
    };
  }

  /** GET /clubs/:clubId/reports/merchandise (T-85, LLD §4.10). */
  async function merchandiseReport(clubId) {
    const [units, revenue, byStatus, stock, openAlerts] = await Promise.all([
      repository.unitsSold(db, clubId),
      repository.merchRevenue(db, clubId),
      repository.ordersByStatus(db, clubId),
      repository.inventory(db, clubId),
      repository.openAlertCount(db, clubId),
    ]);
    return {
      unitsSold: units.map((r) => ({ productId: r.product_id, productName: r.product_name, sizeLabel: r.size_label, units: r.units })),
      totalUnitsSold: units.reduce((n, r) => n + r.units, 0),
      revenuePaise: revenue,
      ordersByStatus: byStatus.map((r) => ({ status: r.status, orders: r.orders })),
      inventory: stock.map((r) => ({
        productName: r.product_name,
        sizeLabel: r.size_label,
        onHand: r.stock_on_hand,
        reserved: r.stock_reserved,
        available: r.stock_on_hand - r.stock_reserved,
        threshold: r.low_stock_threshold,
        lowStock: r.low_stock,
      })),
      openAlerts,
    };
  }

  return Object.freeze({ financeReport, membershipReport, merchandiseReport });
}
