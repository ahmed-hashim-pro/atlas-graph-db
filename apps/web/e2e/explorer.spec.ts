import { expect, test } from '@playwright/test';

test('register, login, create a database, see it, and switch theme', async ({ page }) => {
  const username = `e2e_${Date.now()}`;

  // Register.
  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('secret12');
  await page.getByRole('button', { name: /create account/i }).click();

  // Lands on the database picker (registration logs in).
  await expect(page).toHaveURL(/\/databases$/);
  await expect(page.getByRole('heading', { name: 'Databases' })).toBeVisible();

  // Create a database.
  await page.getByPlaceholder('new-database').fill('e2e-kb');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-kb')).toBeVisible();
  await expect(page.getByText('owner')).toBeVisible();

  // Switch the theme — the <html> data-theme attribute updates.
  await page.getByLabel('Theme').selectOption('neon-terminal');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'neon-terminal');

  // Log out returns to login.
  await page.getByRole('button', { name: /log out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});
