import { expect, test } from '@playwright/test';

test('open the workspace console, run a query, see results; open the schema view', async ({ page }) => {
  const username = `e2e_console_${Date.now()}`;

  // Register (logs in) and land on the picker.
  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('secret12');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/databases$/);

  // Create and seed a database so there is data to query.
  await page.getByPlaceholder('new-database').fill('e2e-console');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-console')).toBeVisible();
  const seeded = page.waitForResponse(
    (r) => r.url().includes('/seed/') && r.request().method() === 'POST' && r.ok(),
  );
  await page.getByRole('button', { name: /seed science-history/i }).click();
  await seeded;

  // Open the workspace console and run a query.
  await page.goto('/db/e2e-console');
  await expect(page.getByLabel('AQL console')).toBeVisible();
  // Replace the editor contents and run via the Mod-Enter shortcut. Use
  // `ControlOrMeta` so select-all and the run shortcut map to ⌘ on macOS and
  // Ctrl elsewhere — CodeMirror binds select-all/`Mod-Enter` to the platform
  // primary modifier (⌘ on macOS), so a hard-coded Control+ would no-op there.
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('MATCH (p:Person) RETURN p.name AS name LIMIT 5');
  await page.keyboard.press('ControlOrMeta+Enter');

  // Results table shows the "name" column.
  await expect(page.getByRole('columnheader', { name: 'name' })).toBeVisible();

  // Open the schema view and see at least one label box.
  await page.goto('/db/e2e-console/schema');
  await expect(page.getByRole('heading', { name: 'Schema' })).toBeVisible();
  await expect(page.locator('.schema-node').first()).toBeVisible();
});
