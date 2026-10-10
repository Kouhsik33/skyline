import { expect } from '@playwright/test';

// Seeded demo data (backend/src/db/seedData/demoIds.js, docs/DEMO_ACCOUNTS.md).
export const PASSWORD = 'SkylineDemo#2026';
export const CLUB_ID = '5eed0001-0000-4000-8000-000000000100';
export const PENDING_PAYMENT_ID = '5eed0002-0000-4000-8000-000000000202'; // buyer's INITIATED merch payment
export const USERS = {
  head: { email: 'head@demo.example.test', name: 'Asha Demo (Club Head)' },
  member: { email: 'member@demo.example.test', name: 'Kiran Demo (Member)' },
  buyer: { email: 'buyer@demo.example.test', name: 'Dev Demo (Non-member)' },
};

export async function signIn(page, user, next) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: `Account menu for ${user.name}` })).toBeVisible();
}

export async function signOut(page, user) {
  await page.getByRole('button', { name: `Account menu for ${user.name}` }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}
