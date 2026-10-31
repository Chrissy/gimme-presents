import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures';
import { execFileSync } from 'node:child_process';
import type { ListResponse } from '../../shared/api';

function localWrangler(args: string[]) {
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--config', 'wrangler.jsonc', '--persist-to', process.env.GIMME_LOCAL_STATE_DIR!], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe',
  });
}

test('cookie-owned lists preserve the complete gift workflow and public sharing', async ({ page, browser }, testInfo) => {
  const activatePopoverLink = async (link: Locator) => {
    // The original fixed-width popover overflows narrow screens; retain that layout.
    // Exercise its native link keyboard behavior without forcing pointer clicks through it.
    if (testInfo.project.name === 'mobile') await link.press('Enter');
    else await link.click();
  };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const sampleImage = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="1000" height="600" fill="#e5efe5"/><text x="500" y="310" text-anchor="middle" font-size="36" fill="#176324">Gift photo fixture</text></svg>';
  await page.route('**/test-gift.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: sampleImage }));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Gimme some freakin’ presents!');
  await expect(page.getByText(/Google|Login with/i)).toHaveCount(0);
  await page.getByLabel('List name', { exact: true }).fill('Gifts');
  await page.getByRole('link', { name: 'create my list!' }).click();
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  const listUrl = page.url();
  const editPath = await page.getByRole('link', { name: 'Edit list name' }).getAttribute('href');
  await page.goto(`/${editPath!.split('/').pop()}`);
  await expect(page).toHaveURL(listUrl);
  const add = page.getByRole('complementary', { name: 'Add a gift' });
  // These values preserve the Rails form's native browser appearance on both viewports.
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveCSS('font-family', 'Arial');
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveCSS('font-size', '13.3333px');
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveCSS('padding', '1px 2px');
  await expect(add.locator('form')).toHaveCSS('position', 'fixed');
  await expect(add.locator('form')).toHaveCSS('bottom', '40px');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCSS('font-size', '60px');

  await add.getByLabel('Gift name', { exact: true }).fill('A cozy sweater');
  await add.getByLabel('Gift URL', { exact: true }).fill('https://example.com/sweater');
  await add.getByLabel('Price in dollars').fill('49.95');
  await add.getByRole('link', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article', { name: 'A cozy sweater', exact: true })).toContainText('$49.95');
  // Seed a pre-R2 image to verify legacy compatibility without letting the
  // ingestion endpoint fetch localhost or relying on a live external retailer.
  const saved = await (await page.request.get(`/api/lists/${new URL(listUrl).pathname.slice(1)}`)).json() as ListResponse;
  localWrangler(['d1', 'execute', 'DB', '--local', '--command',
    `UPDATE gifts SET image = 'http://127.0.0.1:4173/test-gift.svg' WHERE id = ${saved.gifts[0].id}`]);
  await page.reload();
  await add.getByLabel('Gift name', { exact: true }).fill('More socks');
  await add.getByLabel('Price in dollars').fill('0');
  await add.getByRole('link', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'More socks');
  await expect(page.getByRole('article').first()).toContainText('$0.00');

  const socks = page.getByRole('article', { name: 'More socks', exact: true });
  await expect(socks.getByRole('link', { name: 'Move More socks down' })).toBeHidden();
  await page.getByRole('link', { name: 'Edit More socks' }).click();
  await expect(socks.getByRole('link', { name: 'Move More socks down' })).toHaveText('[-]');
  await activatePopoverLink(socks.getByRole('link', { name: 'Move More socks down' }));
  await expect(socks.getByRole('link', { name: 'Move More socks down' })).toBeHidden();
  await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'A cozy sweater');
  const editor = page.getByRole('article', { name: 'A cozy sweater', exact: true });
  await expect(editor.getByLabel('Gift name', { exact: true })).toBeHidden();
  await page.getByRole('link', { name: 'Edit A cozy sweater' }).click();
  await expect(editor.getByLabel('Gift name', { exact: true })).toBeVisible();
  await page.getByRole('heading', { level: 1 }).click();
  await expect(editor.getByLabel('Gift name', { exact: true })).toBeHidden();
  await page.getByRole('link', { name: 'Edit A cozy sweater' }).click();
  await editor.getByLabel('Gift name', { exact: true }).fill('An even cozier sweater');
  await editor.getByLabel('Price in dollars').fill('55.50');
  await activatePopoverLink(editor.getByRole('link', { name: 'update my gift!' }));
  await expect(page.getByRole('article').first()).toContainText('$55.50');
  await page.reload();
  await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'An even cozier sweater');
  await expect(page.getByRole('link', { name: 'Edit An even cozier sweater' })).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).not.toContain('gimme_session');

  await page.getByRole('link', { name: 'Edit list name' }).click();
  await expect(page.getByRole('heading')).toHaveCount(0);
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByText('cancel', { exact: true })).toHaveCount(0);
  await page.getByLabel('List name', { exact: true }).fill('Presents, please!');
  await page.getByRole('link', { name: 'update my list!' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(/^Presents, please!/);
  expect(page.url()).toBe(listUrl);
  await expect(page.getByRole('img', { name: 'An even cozier sweater' })).toBeVisible();
  expect(await page.getByRole('img', { name: 'An even cozier sweater' }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1000);
  await page.screenshot({ path: testInfo.outputPath('owned-list.png'), fullPage: true });

  const publicContext = await browser.newContext({ viewport: testInfo.project.use.viewport });
  const publicPage = await publicContext.newPage();
  await publicPage.route('**/test-gift.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: sampleImage }));
  await publicPage.goto(listUrl);
  await expect(publicPage.getByRole('heading', { level: 1 })).toHaveAccessibleName('Presents, please!');
  await expect(publicPage.getByRole('article')).toHaveCount(2);
  await expect(publicPage.getByRole('link', { name: /^Edit |^Delete |^Move / })).toHaveCount(0);
  await expect(publicPage.getByRole('complementary', { name: 'Add a gift' })).toHaveCount(0);
  await publicPage.screenshot({ path: testInfo.outputPath('public-list.png'), fullPage: true });
  await publicContext.close();

  await page.goto('/');
  await expect(page.getByRole('link', { name: /Presents, please!/ })).toHaveCount(0);
  await page.goto(listUrl);
  await page.getByRole('link', { name: 'Edit More socks' }).click();
  await activatePopoverLink(page.getByRole('link', { name: 'Delete More socks' }));
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('link', { name: 'Edit list name' }).click();
  page.once('dialog', async dialog => {
    expect(dialog.message()).toBe('are you sure?!');
    await dialog.accept();
  });
  await page.getByRole('link', { name: 'delete', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.goto(listUrl);
  await expect(page.getByText('That list could not be found.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('stored R2 images render for owners and public visitors without their original host', async ({ page, browser }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('List name', { exact: true }).fill('Hosted photo');
  await page.getByRole('link', { name: 'create my list!' }).click();
  await page.getByLabel('Gift name', { exact: true }).fill('Hosted gift');
  await page.getByRole('link', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  const listUrl = page.url();
  const data = await (await page.request.get(`/api/lists/${new URL(listUrl).pathname.slice(1)}`)).json() as ListResponse;
  const key = `${crypto.randomUUID()}.png`;
  // URL ingestion and byte equality are tested in workerd API tests. Here use
  // the real local R2 binding to prove browser delivery, never a mocked image route.
  localWrangler(['r2', 'object', 'put', `gimme-presents-images-local/${key}`, '--local', '--file', 'public/edit.png', '--content-type', 'image/png']);
  localWrangler(['d1', 'execute', 'DB', '--local', '--command',
    `UPDATE gifts SET image = 'https://unavailable.invalid/photo.png', image_key = '${key}' WHERE id = ${data.gifts[0].id}`]);
  await page.reload();
  const photo = page.getByRole('img', { name: 'Hosted gift', exact: true });
  await expect(photo).toHaveAttribute('src', `/media/${key}`);
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(13);
  const response = await page.request.get(`/media/${key}`);
  expect(response.headers()['cache-control']).toContain('immutable');
  expect(response.headers()['content-type']).toBe('image/png');
  await page.screenshot({ path: testInfo.outputPath('hosted-image.png'), fullPage: true });
  const publicContext = await browser.newContext({ viewport: testInfo.project.use.viewport });
  const visitor = await publicContext.newPage();
  await visitor.goto(listUrl);
  await expect.poll(() => visitor.getByRole('img', { name: 'Hosted gift', exact: true })
    .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(13);
  await publicContext.close();
});

test('conflicting tabs retain drafts until the user reloads and retries', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('List name', { exact: true }).fill('Two tabs');
  await page.getByRole('link', { name: 'create my list!' }).click();
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(second.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await second.getByLabel('Gift name', { exact: true }).fill('Keep my draft');
  await page.getByLabel('Gift name', { exact: true }).fill('First tab gift');
  await page.getByRole('link', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await second.getByRole('link', { name: 'create my gift!' }).click();
  await expect(second.getByRole('button', { name: 'Load latest list' })).toBeVisible();
  await expect(second.getByLabel('Gift name', { exact: true })).toHaveValue('Keep my draft');
  await second.getByRole('button', { name: 'Load latest list' }).click();
  await expect(second.getByRole('link', { name: 'create my gift!' })).toBeEnabled();
  await expect(second.getByLabel('Gift name', { exact: true })).toHaveValue('Keep my draft');
  await second.getByRole('link', { name: 'create my gift!' }).click();
  await expect(second.getByRole('article')).toHaveCount(2);
  await second.close();
});

test('simultaneous first lists in two tabs keep the same browser owner', async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([page.goto('/'), second.goto('/')]);
  await page.getByLabel('List name', { exact: true }).fill('First tab Christmas');
  await second.getByLabel('List name', { exact: true }).fill('Second tab Christmas');
  let firstRequest = true;
  await context.route('**/api/lists', async route => {
    if (firstRequest && route.request().method() === 'POST') {
      firstRequest = false;
      // Model a slow first response: a second cookie-less POST would create a competing owner.
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    await route.continue();
  });
  await Promise.all([
    page.getByRole('link', { name: 'create my list!' }).click(),
    second.getByRole('link', { name: 'create my list!' }).click(),
  ]);
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await Promise.all([page.reload(), second.reload()]);
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('link', { name: /First tab Christmas|Second tab Christmas/ })).toHaveCount(0);
  const response = await context.request.get('/api/me');
  const { lists } = await response.json() as { lists: { name: string }[] };
  expect(lists.map(list => list.name).sort()).toEqual(['First tab Christmas', 'Second tab Christmas']);
  await second.close();
});
