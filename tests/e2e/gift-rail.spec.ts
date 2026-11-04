import { execFileSync } from 'node:child_process';
import type { Locator, Page } from '@playwright/test';
import type { ListResponse } from '../../shared/api';
import { expect, openGiftForm, test } from './fixtures';

const headers = { Origin: 'http://127.0.0.1:4173', 'X-Requested-With': 'gimme-presents' };
const railFor = (page: Page) => page.getByRole('complementary', { name: 'Reorder gifts', exact: true });

async function createGifts(page: Page, count = 4) {
  let response = await page.request.post('/api/lists', { headers, data: { name: 'Christmas wishes' } });
  expect(response.status()).toBe(201);
  let data = await response.json() as ListResponse;
  for (let index = 1; index <= count; index++) {
    response = await page.request.post(`/api/lists/${data.list.id}/gifts`, {
      headers, data: { name: `Gift ${index}`, url: '', image: '', price: '', revision: data.list.revision },
    });
    expect(response.status()).toBe(200);
    data = await response.json() as ListResponse;
  }
  await page.goto(`/${data.list.slug}`);
  await expect(page.getByRole('article')).toHaveCount(count);
  if (count) await expect(railFor(page).getByRole('button')).toHaveCount(count);
  return data;
}

async function keyboardMove(button: Locator, direction = 'ArrowDown') {
  await expect(button.locator('..')).not.toHaveAttribute('data-dnd-dragging', 'true');
  await button.focus();
  await button.press('Space');
  await expect(button.locator('..')).toHaveAttribute('data-dragging', 'true');
  await button.press(direction);
  await button.press('Space');
  await expect(button.locator('..')).not.toHaveAttribute('data-dnd-dragging', 'true');
}

async function drag(page: Page, from: Locator, to: Locator, touch: boolean) {
  const start = (await from.boundingBox())!;
  const end = (await to.boundingBox())!;
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  const endY = end.y + end.height / 2;
  if (touch) {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await expect(from.locator('..')).toHaveAttribute('data-dragging', 'true');
    for (let step = 1; step <= 12; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (endY - y) * step / 12 }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 8, { steps: 3 });
    await expect(from.locator('..')).toHaveAttribute('data-dragging', 'true');
    await page.mouse.move(x, endY, { steps: 12 });
    await page.mouse.up();
  }
}

test('image-only rail reorders with mouse or touch and saves without losing drafts or scroll', async ({ page, browser }, testInfo) => {
  const data = await createGifts(page);
  // Legacy image fixtures stay local and exercise images and broken-image fallback.
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local',
    '--config', 'wrangler.jsonc', '--persist-to', process.env.GIMME_LOCAL_STATE_DIR!, '--command',
    `UPDATE gifts SET image = 'http://127.0.0.1:4173/rail-photo.svg' WHERE id = ${data.gifts[0].id}; UPDATE gifts SET image = 'http://127.0.0.1:4173/rail-missing.png' WHERE id = ${data.gifts[1].id}`], { stdio: 'pipe' });
  await page.route('**/rail-photo.svg', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" rx="40" fill="#e6efe6"/><rect x="150" y="180" width="300" height="260" rx="8" fill="#a52222"/><path d="M300 180V440M150 240H450" stroke="#f3de9c" stroke-width="30"/></svg>' }));
  await page.route('**/rail-missing.png', route => route.fulfill({ status: 404, body: '' }));
  await page.reload();
  const rail = railFor(page);
  const first = rail.getByRole('button', { name: 'Reorder Gift 4', exact: true });
  await expect(first.locator('img')).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Reorder Gift 3', exact: true })).toHaveText('?');
  await expect(rail.getByRole('button', { name: 'Reorder Gift 2', exact: true })).toHaveText('?');
  await expect(rail).not.toContainText('Gift');
  await expect(first).toHaveCSS('cursor', 'grab');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('gift-rail.png') });

  await openGiftForm(page);
  const add = page.getByRole('complementary', { name: 'Add a gift' });
  await add.getByLabel('Gift name', { exact: true }).fill('Keep this unfinished gift');
  await page.evaluate(() => window.scrollTo(0, 350));
  const scroll = await page.evaluate(() => scrollY);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  await page.route('**/reorder', async route => { writes++; await pending; await route.continue(); });
  await drag(page, first, rail.getByRole('button', { name: 'Reorder Gift 2', exact: true }), testInfo.project.name === 'mobile');
  await expect(rail).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'Gift 3');
  await expect(first).toHaveAttribute('aria-disabled', 'true');
  release();
  await expect(rail).toHaveAttribute('aria-busy', 'false');
  expect(writes).toBe(1);
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveValue('Keep this unfinished gift');
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  const expected = ['Gift 3', 'Gift 2', 'Gift 4', 'Gift 1'];
  expect(await page.getByRole('article').evaluateAll(items => items.map(item => item.getAttribute('aria-label')))).toEqual(expected);
  await page.reload();
  await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', expected[0]);
  const saved = await (await page.request.get(`/api/lists/${data.list.slug}`)).json() as ListResponse;
  expect(saved.gifts.map(gift => gift.name)).toEqual(expected);

  const visitor = await browser.newContext();
  const publicPage = await visitor.newPage();
  await publicPage.goto(page.url());
  await expect(publicPage.getByRole('article')).toHaveCount(4);
  await expect(railFor(publicPage)).toHaveCount(0);
  await visitor.close();
  await page.getByRole('link', { name: 'Edit list name' }).click();
  await expect(page.getByLabel('List name', { exact: true })).toBeVisible();
  await expect(railFor(page)).toHaveCount(0);
});

test('keyboard cancellation and no-op do not save; a failed save rolls back and can be retried', async ({ page }) => {
  await createGifts(page);
  const rail = railFor(page);
  const first = rail.getByRole('button', { name: 'Reorder Gift 4', exact: true });
  let writes = 0;
  await page.route('**/reorder', route => {
    writes++;
    return route.fulfill({ status: 503, json: { error: 'Please try again.' } });
  });
  await first.focus();
  await first.press('Space');
  await first.press('ArrowDown');
  await first.press('Escape');
  await expect(first.locator('..')).not.toHaveAttribute('data-dnd-dragging', 'true');
  await expect(rail.getByRole('button').first()).toHaveAccessibleName('Reorder Gift 4');
  await first.press('Space');
  await first.press('Space');
  await expect(first.locator('..')).not.toHaveAttribute('data-dnd-dragging', 'true');
  expect(writes).toBe(0);
  await keyboardMove(first);
  await expect(page.getByRole('alert')).toContainText('Couldn’t save the new order.');
  await expect(rail.getByRole('button').first()).toHaveAccessibleName('Reorder Gift 4');
  await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'Gift 4');
  expect(writes).toBe(1);
  await page.unroute('**/reorder');
  await keyboardMove(first);
  await expect(rail).toHaveAttribute('aria-busy', 'false');
  await expect(rail.getByRole('button').first()).toHaveAccessibleName('Reorder Gift 3');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'Gift 3');
});

test('stale order is rejected and reloading preserves the editor draft before retrying', async ({ page }) => {
  const data = await createGifts(page);
  await page.getByRole('link', { name: 'Edit Gift 4', exact: true }).click();
  const draft = page.getByRole('article', { name: 'Gift 4', exact: true }).getByLabel('Gift name', { exact: true });
  await draft.fill('Unfinished edit');
  const response = await page.request.put(`/api/lists/${data.list.id}`, {
    headers, data: { name: 'Changed in another tab', revision: data.list.revision },
  });
  expect(response.status()).toBe(200);
  const rail = railFor(page);
  const first = rail.getByRole('button', { name: 'Reorder Gift 4', exact: true });
  await keyboardMove(first);
  await expect(page.getByRole('alert')).toContainText('This list changed in another tab.');
  await expect(first).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'Load latest list' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('link', { name: 'Edit Gift 4', exact: true }).click();
  await expect(draft).toHaveValue('Unfinished edit');
  await keyboardMove(first);
  await expect(rail).toHaveAttribute('aria-busy', 'false');
  await expect(rail.getByRole('button').first()).toHaveAccessibleName('Reorder Gift 3');
  await expect(draft).toHaveValue('Unfinished edit');
});

test('empty lists hide the rail and long rails scroll independently', async ({ page }, testInfo) => {
  await createGifts(page, 0);
  await expect(railFor(page)).toHaveCount(0);
  await createGifts(page, 24);
  const rail = railFor(page);
  const before = await page.evaluate(() => scrollY);
  if (testInfo.project.name === 'mobile') {
    const button = rail.getByRole('button').nth(5);
    const box = (await button.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 20 }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
    await expect.poll(() => rail.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  }
  await rail.getByRole('button').last().scrollIntoViewIfNeeded();
  expect(await rail.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => scrollY)).toBe(before);
  await keyboardMove(rail.getByRole('button', { name: 'Reorder Gift 1', exact: true }), 'ArrowUp');
  await expect(rail).toHaveAttribute('aria-busy', 'false');
  await expect(rail.getByRole('button').last()).toHaveAccessibleName('Reorder Gift 2');
});
