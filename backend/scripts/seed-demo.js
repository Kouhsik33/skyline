// Loads the demo data (accounts for every role, clubs, events, merch, finance) into the local
// database. DEV ONLY: see src/db/demo/seedDemo.js.
//
//   npm run seed:demo            add the data; does nothing if it is already there
//   npm run seed:demo -- --reset empty EVERY table first, then load it (rebuilds the dates too)
import { db } from '../src/db/knex.js';
import { config } from '../src/config/index.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, assertSomsDatabase, countRows, demoDataPresent, seedDemo } from '../src/db/demo/seedDemo.js';

const reset = process.argv.includes('--reset');

function describeTarget() {
  const conn = db.client.config.connection;
  try {
    const u = new URL(typeof conn === 'string' ? conn : `postgres://${conn.host}:${conn.port}/${conn.database}`);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return 'the configured database';
  }
}

async function main() {
  if (config.isProduction) {
    console.error('Refusing to load demo data: NODE_ENV is production. Demo accounts share a public password.');
    process.exit(1);
  }
  console.log(`Target database: ${describeTarget()}`);
  await assertSomsDatabase(db);

  const present = await demoDataPresent(db);
  if (present && !reset) {
    console.log('Demo data is already loaded, nothing to do. Use `npm run seed:demo -- --reset` to rebuild it.');
    printAccounts();
    return;
  }
  if (reset) {
    const before = await countRows(db);
    console.log(`--reset: emptying every table first (currently ${before.users} users, ${before.clubs} clubs, ${before.events} events, ${before.payments} payments).`);
  }

  const { counts, receiptFiles } = await seedDemo(db, { reset });
  console.log('Loaded:', Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', '));
  if (receiptFiles.written) console.log(`Receipt PDFs: ${receiptFiles.written} written to ${receiptFiles.dir}`);
  else console.log(`Receipt PDFs not written (${receiptFiles.error ?? 'none'}); expense rows work, but opening a receipt will 404. Run the seed inside the backend container to include them.`);
  printAccounts();
}

function printAccounts() {
  console.log(`\nSign in with any of these (password for all: ${DEMO_PASSWORD}):`);
  for (const a of DEMO_ACCOUNTS) console.log(`  ${a.email.padEnd(24)} ${a.name.padEnd(15)} ${a.roles}`);
}

main()
  .catch((err) => {
    if (err.code === '23505') {
      console.error(`The database already holds rows that clash with the demo data (${err.detail ?? err.message}).\nRun \`npm run seed:demo -- --reset\` to start from an empty database.`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
