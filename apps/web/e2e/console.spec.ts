import { expect, test } from '@playwright/test';

test('open the workspace console, run a query, see results; open the schema view', async ({
  page,
}) => {
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

test('project a console result onto the canvas and paint an algorithm result', async ({ page }) => {
  const username = `e2e_paint_${Date.now()}`;

  // Register (logs in) and land on the picker.
  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('secret12');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/databases$/);

  // Create and seed a database so there is data to query.
  await page.getByPlaceholder('new-database').fill('e2e-paint');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-paint')).toBeVisible();
  const seeded = page.waitForResponse(
    (r) => r.url().includes('/seed/') && r.request().method() === 'POST' && r.ok(),
  );
  await page.getByRole('button', { name: /seed science-history/i }).click();
  await seeded;

  // Open the workspace; the console dock is open by default.
  await page.goto('/db/e2e-paint');
  await expect(page.getByLabel('AQL console')).toBeVisible();
  const stats = page.locator('.ws-stats');
  await expect(stats).toBeVisible();

  // (a) Project to canvas: run a node-bearing query that returns exactly 5
  // nodes, click "Project to canvas", and assert the workspace stats reflect
  // the projected set ("5 / 5 nodes") — the deterministic affordance that the
  // real GraphStore replaced the displayed graph.
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('MATCH (p:Person) RETURN p LIMIT 5');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('button', { name: 'Project to canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Project to canvas' }).click();
  await expect(stats).toHaveText('5 / 5 nodes');

  // (b) Run an algorithm from the docked Algorithms view and assert it visibly
  // affects the canvas. Switch the dock to Algorithms, run "Degree centrality"
  // (its Direction param defaults to "both", so no input is needed), and assert
  // the deterministic "Painted N results onto the canvas" indicator appears —
  // proving the run reached the real canvas-backed adapter.
  await page.getByRole('button', { name: 'Algorithms' }).click();
  await expect(page.getByRole('heading', { name: 'Algorithms' })).toBeVisible();
  await page.getByRole('button', { name: 'Degree centrality', exact: true }).click();
  // Submit the algorithm form by focusing the Run button and pressing Enter.
  // The canvas overlays the bottom dock in the flex layout, so a positional
  // click can be intercepted; focus + Enter drives the real form submit.
  const runBtn = page.getByRole('button', { name: 'Run', exact: true });
  await runBtn.focus();
  await runBtn.press('Enter');
  await expect(page.locator('.painted')).toContainText(/Painted \d+ results onto the canvas/);
});
