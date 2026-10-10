import { expect, test } from '@playwright/test';
import { CLUB_ID, PENDING_PAYMENT_ID, USERS, signIn, signOut } from './helpers.js';

const FINANCE = `/manage/${CLUB_ID}/finance`;
const CHECKOUT = `/checkout/${PENDING_PAYMENT_ID}`;

test.describe('B5 logout', () => {
  test('logout then Back shows no private data', async ({ page, context }) => {
    await signIn(page, USERS.head);
    await page.goto(FINANCE);
    await expect(page.getByText('Monthly cash flow')).toBeVisible();

    await signOut(page, USERS.head);
    expect((await context.cookies()).find((c) => c.name === 'sid')).toBeUndefined(); // cookie cleared

    await page.goBack();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Monthly cash flow')).toHaveCount(0);
    await expect(page.getByText(USERS.head.name)).toHaveCount(0);

    // Going further back must not show it either.
    await page.goBack();
    await expect(page.getByText('Monthly cash flow')).toHaveCount(0);
    await expect(page.getByText(USERS.head.name)).toHaveCount(0);
  });

  test('logout then log in as another user shows none of the first user’s data', async ({ page }) => {
    await signIn(page, USERS.member);
    await page.goto('/me/payments');
    await expect(page.getByText('SIM-SEED00000001')).toBeVisible(); // member's dues payment
    await page.goto('/me/orders');
    await expect(page.getByText('DEMXPK21')).toBeVisible(); // member's pickup code
    await signOut(page, USERS.member);

    await signIn(page, USERS.buyer);
    await expect(page.getByText(USERS.member.name)).toHaveCount(0);
    await page.goto('/me/payments');
    await expect(page.getByText('SIM-SEED00000003')).toBeVisible(); // the buyer's own payment
    await expect(page.getByText('SIM-SEED00000001')).toHaveCount(0);
    await expect(page.getByText('SIM-SEED00000002')).toHaveCount(0);
    await page.goto('/me/orders');
    await expect(page.getByText('DEMXPK21')).toHaveCount(0);
    // A club page the buyer has no role in is not rendered from any cache.
    await page.goto(FINANCE);
    await expect(page.getByText('Monthly cash flow')).toHaveCount(0);
    await expect(page.getByText("You don't have access to this page")).toBeVisible();
  });
});

test.describe('B6 refresh on protected pages (production build)', () => {
  const cases = [
    { name: 'club finance', user: USERS.head, path: FINANCE, marker: (p) => p.getByText('Monthly cash flow') },
    { name: 'checkout', user: USERS.buyer, path: CHECKOUT, marker: (p) => p.getByRole('heading', { name: 'Checkout' }) },
    { name: 'payment history', user: USERS.buyer, path: '/me/payments', marker: (p) => p.getByRole('heading', { name: 'Payment history' }) },
  ];
  for (const c of cases) {
    test(`refresh keeps the session on ${c.name} (${c.path})`, async ({ page }) => {
      await signIn(page, c.user);
      await page.goto(c.path); // deep link: full document load through nginx fallback
      await expect(c.marker(page)).toBeVisible();
      for (let i = 0; i < 2; i += 1) {
        await page.reload();
        await expect(page).toHaveURL(new RegExp(`${c.path.replace(/[/]/g, '\\/')}$`));
        await expect(c.marker(page)).toBeVisible();
      }
    });
  }

  test('a signed-out deep link goes to /login and returns to the page after sign-in', async ({ page }) => {
    await page.goto(FINANCE);
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel('Email').fill(USERS.head.email);
    await page.getByLabel(/^Password/).fill('SkylineDemo#2026');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`${FINANCE}$`));
    await expect(page.getByText('Monthly cash flow')).toBeVisible();
  });
});
