import { expect, test } from '@playwright/test';

test('cookie-owned lists preserve the complete gift workflow and public sharing', async ({ page, browser }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const sampleImage = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="1000" height="600" fill="#e5efe5"/><text x="500" y="310" text-anchor="middle" font-size="36" fill="#176324">Gift photo fixture</text></svg>';
  await page.route('**/test-gift.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: sampleImage }));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Gimme some freakin’ presents!');
  await expect(page.getByText(/Google|Login with/i)).toHaveCount(0);
  await page.getByLabel('List name', { exact: true }).fill(`Christmas ${testInfo.project.name} ${Date.now()}`);
  await page.getByRole('button', { name: 'create my list!' }).click();
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  const listUrl = page.url();
  const editPath = await page.getByRole('link', { name: 'Edit list name' }).getAttribute('href');
  await page.goto(`/${editPath!.split('/').pop()}`);
  await expect(page).toHaveURL(listUrl);
  const add = page.getByRole('complementary', { name: 'Add a gift' });

  await add.getByLabel('Gift name', { exact: true }).fill('A cozy sweater');
  await add.getByLabel('Gift URL', { exact: true }).fill('https://example.com/sweater');
  await add.getByLabel('Image URL', { exact: true }).fill('http://127.0.0.1:4173/test-gift.svg');
  await add.getByLabel('Price in dollars').fill('49.95');
  await add.getByRole('button', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article', { name: 'A cozy sweater', exact: true })).toContainText('$49.95');
  await add.getByLabel('Gift name', { exact: true }).fill('More socks');
  await add.getByLabel('Price in dollars').fill('0');
  await add.getByRole('button', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'More socks');
  await expect(page.getByRole('article').first()).toContainText('$0.00');

  await page.getByRole('button', { name: 'Move More socks down' }).click();
  await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'A cozy sweater');
  await page.getByRole('button', { name: 'Edit A cozy sweater' }).click();
  const editor = page.getByRole('article', { name: 'A cozy sweater', exact: true });
  await editor.getByLabel('Gift name', { exact: true }).fill('An even cozier sweater');
  await editor.getByLabel('Price in dollars').fill('55.50');
  await editor.getByRole('button', { name: 'update my gift!' }).click();
  await expect(page.getByRole('article').first()).toContainText('$55.50');
  await page.reload();
  await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'An even cozier sweater');
  await expect(page.getByRole('button', { name: 'Edit An even cozier sweater' })).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).not.toContain('gimme_session');

  await page.getByRole('link', { name: 'Edit list name' }).click();
  await page.getByLabel('List name', { exact: true }).fill('Presents, please!');
  await page.getByRole('button', { name: 'update my list!' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(/^Presents, please!/);
  expect(page.url()).toBe(listUrl);
  await expect(page.getByRole('img', { name: 'An even cozier sweater' })).toBeVisible();
  expect(await page.getByRole('img', { name: 'An even cozier sweater' }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1000);
  await page.screenshot({ path: testInfo.outputPath('owned-list.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const publicContext = await browser.newContext({ viewport: testInfo.project.use.viewport });
  const publicPage = await publicContext.newPage();
  await publicPage.route('**/test-gift.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: sampleImage }));
  await publicPage.goto(listUrl);
  await expect(publicPage.getByRole('heading', { level: 1 })).toHaveAccessibleName('Presents, please!');
  await expect(publicPage.getByRole('article')).toHaveCount(2);
  await expect(publicPage.getByRole('button', { name: /^Edit |^Delete |^Move / })).toHaveCount(0);
  await expect(publicPage.getByRole('complementary', { name: 'Add a gift' })).toHaveCount(0);
  await publicPage.screenshot({ path: testInfo.outputPath('public-list.png'), fullPage: true });
  await publicContext.close();

  await page.getByRole('link', { name: 'My lists / make another' }).click();
  await expect(page.getByRole('link', { name: /Presents, please!/ })).toBeVisible();
  await page.getByRole('link', { name: /Presents, please!/ }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete More socks' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('link', { name: 'Edit list name' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'delete', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.goto(listUrl);
  await expect(page.getByText('That list could not be found.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('conflicting tabs retain drafts until the user reloads and retries', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('List name', { exact: true }).fill(`Two tabs ${Date.now()}`);
  await page.getByRole('button', { name: 'create my list!' }).click();
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(second.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await second.getByLabel('Gift name', { exact: true }).fill('Keep my draft');
  await page.getByLabel('Gift name', { exact: true }).fill('First tab gift');
  await page.getByRole('button', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await second.getByRole('button', { name: 'create my gift!' }).click();
  await expect(second.getByRole('button', { name: 'Load latest list' })).toBeVisible();
  await expect(second.getByLabel('Gift name', { exact: true })).toHaveValue('Keep my draft');
  await second.getByRole('button', { name: 'Load latest list' }).click();
  await expect(second.getByRole('button', { name: 'create my gift!' })).toBeEnabled();
  await expect(second.getByLabel('Gift name', { exact: true })).toHaveValue('Keep my draft');
  await second.getByRole('button', { name: 'create my gift!' }).click();
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
    page.getByRole('button', { name: 'create my list!' }).click(),
    second.getByRole('button', { name: 'create my list!' }).click(),
  ]);
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await Promise.all([page.reload(), second.reload()]);
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('link', { name: /First tab Christmas/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Second tab Christmas/ })).toBeVisible();
  await second.close();
});
