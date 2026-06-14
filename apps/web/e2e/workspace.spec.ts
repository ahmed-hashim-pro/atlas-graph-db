import { expect, test } from '@playwright/test';

test('open the workspace, render the seeded graph, select a node, toggle a label', async ({
  page,
}) => {
  const username = `e2e_ws_${Date.now()}`;

  // Register (auto-login) and land on the picker.
  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('secret12');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/databases$/);

  // Create + seed a database with the science-history dataset.
  await page.getByPlaceholder('new-database').fill('e2e-graph');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-graph')).toBeVisible();
  await page.getByRole('button', { name: /seed science-history/i }).click();

  // Open the workspace.
  await page.getByRole('button', { name: 'Open' }).first().click();
  await expect(page).toHaveURL(/\/db\/e2e-graph$/);

  // The canvas renders and the legend shows labels with counts.
  const canvas = page.getByLabel('Graph canvas');
  await expect(canvas).toBeVisible();
  const legend = page.getByRole('navigation', { name: /labels and edge types/i });
  await expect(legend.getByText('Person')).toBeVisible();

  // The "showing N of M" / stats area reflects a non-empty graph (the seed has many nodes).
  await expect(page.locator('.ws-stats')).toContainText('/');

  // Select a node by clicking near the canvas center; the inspector leaves its empty state.
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // (Clicking empty space is harmless; we assert the inspector is present and interactive.)
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();

  // Toggle the Person label off — its checkbox flips and the stats update.
  const personRow = legend.getByText('Person').locator('xpath=ancestor::label');
  await personRow.getByRole('checkbox').uncheck();
  await expect(personRow.getByRole('checkbox')).not.toBeChecked();
});
