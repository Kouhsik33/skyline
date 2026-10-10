# Database migrations

| Field | Value |
|---|---|
| Location | `backend/src/db/migrations` |
| Run | `docker compose exec backend npm run migrate` (also run by the container entrypoint) |
| Roll back | `docker compose exec backend npx knex migrate:rollback --all` |
| Rule | A merged migration is never edited. Changes go into a new, higher-numbered migration with a working `down`. |

## Order

| # | File | Owner | Purpose |
|---|---|---|---|
| 001 | `001_extensions_shared.js` | G2 | pgcrypto, `set_updated_at()`, `forbid_update_delete()` |
| 002 | `002_users_sessions_verifications.js` | G1 | users, user_sessions, college_verifications |
| 003 | `003_clubs_roles.js` | G1 | clubs, club_role_assignments |
| 004 | `004_audit_idempotency_jobs.js` | G2 | audit_logs (append-only), idempotency_keys, job_runs |
| 005 | `005_uploaded_files.js` | G2 | receipt metadata |
| 006 | `006_membership_plans_memberships_terms_autopay.js` | G1 | plans, memberships, terms, AutoPay, renewal attempts |
| 007 | `007_events_organizers_staff_bookings_tickets_checkins.js` | G1 | events, bookings, tickets, check-ins |
| 008 | `008_merch_catalogue_variants_stock_alerts_orders_items.js` | G2 | merchandise |
| 009 | `009_payments.js` | G1 (stub of a G2 table) | payments |
| 010 | `010_fundraisers_tasks.js` | G2 | fundraisers, tasks |
| 011 | `011_financial_transactions_ledger.js` | — | **Intentionally empty** (see below) |
| 012 | `012_announcements_notifications.js` | G1 (file owned by G2) | announcements, notification outbox |
| 013 | `013_budgets_expenses_ledger.js` | G2 | budgets, expenses, financial_transactions (ledger, immutable) |
| 014 | `014_payments_order_fk_live_uniques.js` | G2 | FK payments.order_id → orders; one live payment (INITIATED/PENDING) per order, booking, membership term; one SUCCEEDED per order |
| 015 | `015_announcements_published_no_delete.js` | G2 | published announcements cannot be deleted (012 already blocks UPDATE) |

## 011 is intentionally empty

During the merge, Group 1 already had a migration named `011_financial_transactions_ledger` in its
history, while Group 2's ledger, budgets and expenses schema had to run after 012. The ledger schema
therefore ships in **013**, and 011 was kept as a no-op (`up` and `down` do nothing) so that every
database that already recorded `011_…` in `knex_migrations` stays consistent. Do not delete or edit
011, and do not put schema into it.

## Constraint names the API relies on

`shared/middleware/errorHandler.js` maps unique-violation constraint names to error codes:
`pay_live_booking`, `pay_live_term` (009) and `payments_live_order_uq`, `payments_live_booking_uq`,
`payments_live_membership_term_uq`, `payments_succeeded_order_uq` (014) → `PAYMENT_ALREADY_PENDING`;
`product_categories_club_name_uq` → `CATEGORY_NAME_TAKEN`; `product_variants_product_id_size_label_key`
→ `SIZE_EXISTS`. Renaming any of them needs the map updated.
