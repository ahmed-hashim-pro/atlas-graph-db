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

  // Seed and WAIT for the async seed to actually commit before opening the workspace —
  // otherwise the workspace loads an empty DB (the seed POST is still in flight).
  const seeded = page.waitForResponse(
    (r) => r.url().includes('/seed/') && r.request().method() === 'POST' && r.ok(),
  );
  await page.getByRole('button', { name: /seed science-history/i }).click();
  await seeded;

  // Open the workspace.
  await page.getByRole('button', { name: 'Open' }).first().click();
  await expect(page).toHaveURL(/\/db\/e2e-graph$/);

  // The canvas renders and the legend shows the seeded labels with counts.
  const canvas = page.getByLabel('Graph canvas');
  await expect(canvas).toBeVisible();
  const legend = page.getByRole('navigation', { name: /labels and edge types/i });
  await expect(legend.getByText('Person')).toBeVisible();

  // The "showing N of M" stats reflect a non-empty graph: N / M with a non-zero M.
  const stats = page.locator('.ws-stats');
  await expect(stats).toContainText('/');
  await expect
    .poll(async () => {
      const text = (await stats.textContent())?.trim() ?? '';
      const total = Number(text.split('/')[1]?.replace(/\D/g, ''));
      return Number.isFinite(total) ? total : 0;
    })
    .toBeGreaterThan(0);

  // Drive a REAL selection through the canvas: focus it and use keyboard selection
  // (deterministic, not pixel-precise — the seed exceeds a handful of nodes). The
  // inspector must then leave its empty state and show the selected node.
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText(/select a node or edge/i);
  await canvas.focus();
  await canvas.press('Enter');
  await expect(inspector.getByRole('heading', { name: 'Connections', exact: false })).toBeVisible();
  await expect(inspector).not.toContainText(/select a node or edge/i);

  // Toggle the Person label off — its checkbox flips.
  const personRow = legend.getByText('Person').locator('xpath=ancestor::label');
  await personRow.getByRole('checkbox').uncheck();
  await expect(personRow.getByRole('checkbox')).not.toBeChecked();
});
