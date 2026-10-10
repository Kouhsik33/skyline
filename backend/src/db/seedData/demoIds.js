// Fixed ids for the dev/demo seed (seeds/010_group1_seed.js, seeds/020_group2_seed.js).
// Fixed ids make the seeds idempotent: every insert is ON CONFLICT DO NOTHING.
// Format: 5eed<group>-0000-4000-8000-<12-digit serial> (valid UUID v4 layout).

const id = (group, n) => `5eed000${group}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const G1 = Object.freeze({
  users: {
    head: id(1, 1),
    treasurer: id(1, 2),
    volunteer: id(1, 3),
    member: id(1, 4),
    buyer: id(1, 5),
    organizer: id(1, 6),
  },
  club: id(1, 100),
  roles: { head: id(1, 201), treasurer: id(1, 202), volunteer: id(1, 203) },
  plan: id(1, 300),
  membership: id(1, 400),
  term: id(1, 401),
  event: id(1, 500),
});

export const G2 = Object.freeze({
  files: { submitted: id(2, 1), paid: id(2, 2), direct: id(2, 3), approved: id(2, 4) },
  category: id(2, 100),
  products: { tee: id(2, 110), hoodie: id(2, 111) },
  variants: { teeS: id(2, 120), teeM: id(2, 121), teeL: id(2, 122), hoodieM: id(2, 123), hoodieL: id(2, 124) },
  movements: { teeS: id(2, 130), teeM: id(2, 131), hoodieM: id(2, 133), hoodieL: id(2, 134), reservePending: id(2, 135), reserveConfirmed: id(2, 136), saleConfirmed: id(2, 137) },
  lowStockAlerts: { teeL: id(2, 140), hoodieL: id(2, 141) },
  orders: { confirmed: id(2, 150), pending: id(2, 151) },
  orderItems: { confirmed: id(2, 152), pending: id(2, 153) },
  payments: { dues: id(2, 200), merchConfirmed: id(2, 201), merchPending: id(2, 202) },
  fundraiser: id(2, 300),
  tasks: { inProgress: id(2, 310), todo: id(2, 311), done: id(2, 312) },
  budget: id(2, 400),
  expenses: { submitted: id(2, 500), paid: id(2, 501), direct: id(2, 502), approved: id(2, 503) },
  ledger: { dues: id(2, 600), merch: id(2, 601), income: id(2, 602), payout: id(2, 603), direct: id(2, 604) },
  incomeEntrySource: id(2, 610),
});
