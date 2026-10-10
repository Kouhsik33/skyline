// Read-only report queries (LLD §1.2: reporting reads any table, writes none). Club-scoped.
// from/to are IST calendar dates, inclusive.

function inPeriod(q, { from, to, timeZone }) {
  if (from) q.whereRaw('occurred_at >= (?::date)::timestamp AT TIME ZONE ?', [from, timeZone]);
  if (to) q.whereRaw('occurred_at < ((?::date) + 1)::timestamp AT TIME ZONE ?', [to, timeZone]);
  return q;
}

/** Σ amount and row count per (direction, category) of the club's ledger in the period. */
export function ledgerCategoryBreakdown(conn, clubId, period) {
  const q = conn('financial_transactions')
    .where({ club_id: clubId })
    .groupBy('direction', 'category')
    .select('direction', 'category', conn.raw('sum(amount_paise)::bigint AS total'), conn.raw('count(*)::int AS entries'));
  return inPeriod(q, period);
}

// ---- membership report (LLD §4.10, §5.15) ---------------------------------------------------

/** Effective ACTIVE members (status ACTIVE and not past expiry) grouped by current plan. */
export async function activeMembersByPlan(conn, clubId, today) {
  const { rows } = await conn.raw(
    `SELECT m.current_plan_id AS plan_id, coalesce(p.name, '(no plan)') AS plan_name, count(*)::int AS members
       FROM memberships m LEFT JOIN membership_plans p ON p.id = m.current_plan_id
      WHERE m.club_id = ? AND m.status = 'ACTIVE' AND m.expires_on >= ?
      GROUP BY 1, 2 ORDER BY 2`,
    [clubId, today],
  );
  return rows;
}

/** PAID terms per IST month of payment, split JOIN / RENEWAL. */
export async function termsPerMonth(conn, clubId, timeZone) {
  const { rows } = await conn.raw(
    `SELECT to_char(date_trunc('month', paid_at AT TIME ZONE ?), 'YYYY-MM') AS month,
            count(*) FILTER (WHERE kind = 'JOIN')::int AS joins,
            count(*) FILTER (WHERE kind = 'RENEWAL')::int AS renewals
       FROM membership_terms WHERE club_id = ? AND status = 'PAID'
      GROUP BY 1 ORDER BY 1`,
    [timeZone, clubId],
  );
  return rows;
}

export async function duesCollected(conn, clubId) {
  const { rows } = await conn.raw(
    `SELECT coalesce(sum(amount_paise), 0)::bigint AS total FROM financial_transactions
      WHERE club_id = ? AND category IN ('MEMBERSHIP_DUES', 'MEMBERSHIP_RENEWAL')`,
    [clubId],
  );
  return rows[0].total;
}

export async function membershipCounts(conn, clubId, today, in7) {
  const { rows } = await conn.raw(
    `SELECT count(*) FILTER (WHERE status = 'ACTIVE' AND expires_on BETWEEN ? AND ?)::int AS expiring_in_7_days,
            count(*) FILTER (WHERE status = 'ACTIVE' AND expires_on >= ? AND autopay_enabled)::int AS autopay_enabled
       FROM memberships WHERE club_id = ?`,
    [today, in7, today, clubId],
  );
  return rows[0];
}

export async function renewalAttemptsByStatus(conn, clubId) {
  const { rows } = await conn.raw(
    `SELECT ra.status, count(*)::int AS attempts FROM renewal_attempts ra
       JOIN memberships m ON m.id = ra.membership_id
      WHERE m.club_id = ? GROUP BY 1 ORDER BY 1`,
    [clubId],
  );
  return rows;
}

// ---- merchandise report (LLD §4.10, §5.15) --------------------------------------------------

export async function unitsSold(conn, clubId) {
  const { rows } = await conn.raw(
    `SELECT p.id AS product_id, p.name AS product_name, v.size_label, sum(i.quantity)::int AS units
       FROM order_items i
       JOIN orders o ON o.id = i.order_id AND o.status IN ('CONFIRMED', 'PICKED_UP')
       JOIN products p ON p.id = i.product_id
       JOIN product_variants v ON v.id = i.variant_id
      WHERE i.club_id = ?
      GROUP BY 1, 2, 3 ORDER BY 2, 3`,
    [clubId],
  );
  return rows;
}

export async function merchRevenue(conn, clubId) {
  const { rows } = await conn.raw(
    `SELECT coalesce(sum(amount_paise), 0)::bigint AS total FROM financial_transactions WHERE club_id = ? AND category = 'MERCH_SALE'`,
    [clubId],
  );
  return rows[0].total;
}

export async function ordersByStatus(conn, clubId) {
  const { rows } = await conn.raw(`SELECT status, count(*)::int AS orders FROM orders WHERE club_id = ? GROUP BY 1 ORDER BY 1`, [clubId]);
  return rows;
}

export async function inventory(conn, clubId) {
  const { rows } = await conn.raw(
    `SELECT p.name AS product_name, v.size_label, v.stock_on_hand, v.stock_reserved, v.low_stock_threshold,
            EXISTS (SELECT 1 FROM low_stock_alerts a WHERE a.variant_id = v.id AND a.status = 'OPEN') AS low_stock
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.club_id = ? ORDER BY 1, 2`,
    [clubId],
  );
  return rows;
}

export async function openAlertCount(conn, clubId) {
  const { rows } = await conn.raw(`SELECT count(*)::int AS n FROM low_stock_alerts WHERE club_id = ? AND status = 'OPEN'`, [clubId]);
  return rows[0].n;
}
