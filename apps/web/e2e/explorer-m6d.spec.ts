import { expect, test } from '@playwright/test';

test('import data, then find a node with ⌘K and center it on the canvas', async ({ page }) => {
  const username = `m6d_${Date.now()}`;

  // Register (auto-logs in) and create a database.
  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('secret12');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/databases$/);

  await page.getByPlaceholder('new-database').fill('m6d-kb');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('m6d-kb')).toBeVisible();

  // Import a tiny JSON graph via the Import page.
  await page.getByRole('link', { name: 'Import' }).first().click();
  await expect(page).toHaveURL(/\/databases\/import/);
  await page.getByLabel(/Paste JSON/).fill(
    JSON.stringify({
      nodes: [
        { tempId: 'a', labels: ['Person'], properties: { name: 'Ada Lovelace' } },
        { tempId: 'b', labels: ['Person'], properties: { name: 'Bob' } },
      ],
      edges: [{ from: 'a', to: 'b', type: 'KNOWS', properties: {} }],
    }),
  );
  await page.getByRole('button', { name: /run import/i }).click();
  await expect(page.getByText(/Committed/)).toContainText('2');

  // Open the workspace and search for the node with ⌘K.
  await page.goto('/db/m6d-kb');
  await expect(page.getByRole('heading', { name: 'm6d-kb' })).toBeVisible();
  await page.locator('.workspace').focus();
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'Search nodes' });
  await expect(palette).toBeVisible();
  // CONTAINS is case-sensitive in the engine, so search with the real casing.
  await page.getByPlaceholder('Search nodes by name…').fill('Ada');
  await expect(page.getByRole('option', { name: /Ada Lovelace/ })).toBeVisible();
  await page.getByRole('option', { name: /Ada Lovelace/ }).click();
  // Selecting a hit closes the palette and selects the node (inspector shows it).
  await expect(palette).toBeHidden();
});
