# SOMS Backend (Group 1 — Engagement)

Node.js 20+ Express modular monolith for auth, clubs, memberships, pricing, events, announcements, event reporting, and membership jobs. Finance payments/ledger and notifications include **G2-STUB** implementations so Group 1 integration tests run without Group 2.

## Setup

```bash
cp ../.env.example ../.env   # or export DATABASE_URL
cd backend
npm install
npm run migrate
npm run seed                 # no-op; college roster is fixtures/students.mock.json (see verification/fixtures/README.md)
npm start                    # http://localhost:4000/api/v1/health
```

PostgreSQL 16 required. Tests use `TEST_DATABASE_URL` or `DATABASE_URL` (database `soms_test` recommended).

```bash
npm test
```

## Demo data (dev only)

`npm run seed` is a no-op by design: the college roster is mocked and nobody is pre-verified. For clicking through every role you can instead load the same story the frontend's in-browser demo tells (3 clubs, 42 users, events with tickets and check-ins, merchandise orders, fundraisers, expenses, a ledger that reconciles):

```bash
docker compose exec backend npm run seed:demo           # add the data; no-op if it is already there
docker compose exec backend npm run seed:demo -- --reset # EMPTY EVERY TABLE, then reload (also refreshes the dates)
```

Run it inside the container so the database host, the verification key and the receipt folder (`UPLOAD_DIR`) all match the running API. From the host, set `DATABASE_URL=postgres://soms:soms@localhost:5433/soms` (port 5433 is this project's Postgres; 5432 may be another project's).

Every demo account has password **`demo1234`** and is created already college-verified, which the real register flow never allows, so the script refuses to run when `NODE_ENV=production`. Accounts: `asha@srkrec.ac.in` (club head Skyline), `ravi@srkrec.ac.in` (treasurer), `meera@srkrec.ac.in` (volunteer/staff), `karthik@srkrec.ac.in` (club head Photography, treasurer Robotics, organizer), `vikram@srkrec.ac.in` (club head Robotics), `priya.nair@gmail.com` (no roles, unverified). With `REACT_APP_SHOW_DEMO_ACCOUNTS=true` (set in `frontend/.env.development`) the sign-in page shows them as one-click buttons.

Dates are relative to the day you run it, so re-run with `--reset` when they go stale. Code: `scripts/seed-demo.js`, `src/db/demo/seedDemo.js`.

## API testing (Postman / cURL)

Import **`postman/SOMS-Group1.postman_collection.json`** and **`postman/SOMS-Local.postman_environment.json`**. Step-by-step cURLs: **`postman/CURL-WALKTHROUGH.md`**. Before publishing events, run **`postman/setup-organizer.sql`** (organizer routes not wired yet).

## CLI (ASM-01)

```bash
npm run cli -- create-club --slug skyline --name "Skyline Association" --prefix SKY
npm run cli -- assign-club-head --club-id <uuid> --email head@skyline.ac.in
```

## Module layout

See `docs/LLD.md` §1.1. Composition root: `src/container.js`. Payment handlers registered for `MEMBERSHIP_JOIN`, `MEMBERSHIP_RENEWAL`, `EVENT_TICKET`.

## Migrations owned here

002, 003, 006, 007; plus minimal 009/011/012 stubs coordinated with Group 2.
