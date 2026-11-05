import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function openList(page: Page) {
  await page.goto('/');
  await page.getByLabel('List name', { exact: true }).fill('Things I definitely need');
  await page.getByRole('link', { name: 'create my list!' }).click();
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  return page.getByRole('complementary', { name: 'Add a gift' });
}

test('manual entry opens a blank draft and saves a title and picture without a link or lookup', async ({ page }, info) => {
  const add = await openList(page);
  await page.clock.install();
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(request.url());
  });
  await page.screenshot({ path: info.outputPath('manual-entry-button.png'), fullPage: true });
  await add.getByRole('button', { name: 'or manually enter a gift', exact: true }).click();
  await expect(add.getByLabel('Gift name', { exact: true })).toBeFocused();
  for (const label of ['Gift name', 'Gift URL', 'Price in dollars']) {
    await expect(add.getByLabel(label, { exact: true })).toHaveValue('');
  }
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveCount(0);

  // A pending automatic lookup must also be canceled when manual entry is chosen.
  await add.getByRole('link', { name: '< back', exact: true }).click();
  await add.getByLabel('Gift URL').fill('https://shop.example.com/unneeded');
  await add.getByRole('button', { name: 'or manually enter a gift', exact: true }).click();
  await page.clock.runFor(4000);
  await expect(add.getByLabel('Gift URL')).toHaveValue('');
  await add.getByLabel('Gift name', { exact: true }).fill('Cool jewelry');
  await add.getByLabel('Upload image', { exact: true }).setInputFiles('public/edit.png');
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveAttribute('src', /^blob:/);
  expect(writes).toEqual([]);
  await page.screenshot({ path: info.outputPath('manual-gift-draft.png'), fullPage: true });
  await add.getByRole('link', { name: 'create my gift!' }).click();
  const article = page.getByRole('article', { name: 'Cool jewelry', exact: true });
  await expect(article.getByRole('img')).toHaveAttribute('src', /^\/media\//);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatch(/\/gifts$/);
  await expect(add.getByRole('button', { name: 'or manually enter a gift', exact: true })).toBeVisible();
  await page.reload();
  await expect(article).toBeVisible();
  const saved = await (await page.request.get(`/api/lists${new URL(page.url()).pathname}`)).json();
  expect(saved.gifts[0]).toMatchObject({ name: 'Cool jewelry', url: '', priceCents: null });
});

test('manual entry cancels an active lookup and late results cannot overwrite the blank draft', async ({ page }) => {
  const add = await openList(page);
  await page.clock.install();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let completed!: () => void;
  const done = new Promise<void>(resolve => { completed = resolve; });
  await page.route('**/api/lists/*/gift-suggestion', async route => {
    await pending;
    await route.fulfill({ json: { draft: { name: 'Too late', url: 'https://shop.example.com/shoes', image: '', price: '999' } } });
    completed();
  });
  await add.getByLabel('Gift URL').fill('https://shop.example.com/shoes');
  await page.clock.runFor(400);
  await expect(add.getByRole('status')).toContainText('Checking');
  await add.getByRole('button', { name: 'or manually enter a gift', exact: true }).click();
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveValue('');
  await add.getByLabel('Gift name', { exact: true }).fill('Cool hats');
  release(); await done;
  await page.clock.runFor(4000);
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveValue('Cool hats');
  await expect(add.getByLabel('Gift URL')).toHaveValue('');
  await expect(add.getByLabel('Price in dollars')).toHaveValue('');
  await expect(add.getByRole('status')).toHaveCount(0);
});

test('a link reveals an editable draft, saves user changes, and returns to URL entry', async ({ page }, info) => {
  const add = await openList(page);
  let calls = 0;
  await page.route('**/api/lists/*/gift-suggestion', route => {
    calls++;
    return route.fulfill({ json: { draft: { name: 'a mug for my personality substitute', url: 'https://shop.example.com/mug', price: '24.50', image: 'https://shop.example.com/mug.jpg' } } });
  });
  await page.route('https://shop.example.com/mug.jpg', route => route.fulfill({ path: 'public/edit.png', contentType: 'image/png' }));
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('gift-link.png'), fullPage: true });
  await add.getByLabel('Gift URL', { exact: true }).fill('https://shop.example.com/mug');
  expect(calls).toBe(0);
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveValue('a mug for my personality substitute');
  await expect(add.getByLabel('Price in dollars')).toHaveValue('24.50');
  await expect(add.getByRole('img', { name: 'Image preview' })).toBeVisible();
  await expect(add.getByRole('heading')).toHaveCount(0);
  await expect(add.getByRole('link', { name: '< back', exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('gift-draft.png'), fullPage: true });
  await add.getByLabel('Gift name', { exact: true }).fill('The mug I actually want');
  await add.getByLabel('Price in dollars').fill('22');
  await add.getByRole('button', { name: 'Remove image' }).click();
  await add.getByRole('link', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article', { name: 'The mug I actually want' })).toContainText('$22.00');
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveCount(0);
  await expect(add.getByLabel('Gift URL')).toHaveValue('');
  expect(calls).toBe(1);
});

test('back returns to the preserved link without a new lookup or uploading the discarded image', async ({ page }, info) => {
  const add = await openList(page);
  await page.clock.install();
  const lookups: string[] = [];
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().includes('/api/') && !request.url().endsWith('/gift-suggestion')) writes.push(request.url());
  });
  await page.route('**/api/lists/*/gift-suggestion', route => {
    const { url } = route.request().postDataJSON();
    lookups.push(url);
    return route.fulfill({ json: { draft: { name: 'stupid mug', url, price: '', image: '' } } });
  });
  await add.getByLabel('Gift URL').fill('https://shop.example.com/mug');
  await page.clock.runFor(400);
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveValue('stupid mug');
  await add.getByLabel('Upload image', { exact: true }).setInputFiles('public/edit.png');
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveAttribute('src', /^blob:/);
  await add.getByRole('link', { name: '< back', exact: true }).click();
  await expect(add.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await expect(add.getByLabel('Gift URL')).toHaveValue('https://shop.example.com/mug');
  await expect(add.getByLabel('Gift URL')).toBeFocused();
  await page.clock.runFor(4000);
  expect(lookups).toHaveLength(1);
  expect(writes).toEqual([]);
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('gift-back.png'), fullPage: true });
  await add.getByLabel('Gift URL').fill('https://shop.example.com/shoes');
  await page.clock.runFor(400);
  await expect(add.getByLabel('Gift name', { exact: true })).toBeVisible();
  expect(lookups).toEqual(['https://shop.example.com/mug', 'https://shop.example.com/shoes']);
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('limits reveal the manual form without losing the URL', async ({ page }, info) => {
  const add = await openList(page);
  await page.route('**/api/lists/*/gift-suggestion', route => route.fulfill({ status: 429, json: { error: 'Gift suggestions have reached a usage limit. You can still add gifts manually.' } }));
  await add.getByLabel('Gift URL').fill('https://shop.example.com/shoes');
  await expect(add.getByLabel('Gift URL')).toHaveValue('https://shop.example.com/shoes');
  await expect(add.getByRole('status')).toContainText('manually');
  await add.getByLabel('Gift name', { exact: true }).fill('Shoes');
  await page.screenshot({ path: info.outputPath('gift-manual-fallback.png'), fullPage: true });
  await add.getByRole('link', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article', { name: 'Shoes' })).toBeVisible();
});

test('lookup waits for a complete link and uses only the final URL after typing settles', async ({ page }) => {
  const add = await openList(page);
  await page.clock.install();
  const urls: string[] = [];
  await page.route('**/api/lists/*/gift-suggestion', route => {
    const { url } = route.request().postDataJSON();
    urls.push(url);
    return route.fulfill({ json: { draft: { name: 'Shoes', url, image: '', price: '' } } });
  });
  const input = add.getByLabel('Gift URL');
  await expect(add.getByRole('link', { name: 'fill in my gift!' })).toHaveCount(0);
  await expect(add.getByRole('button', { name: 'or manually enter a gift', exact: true })).toBeVisible();
  await input.fill('https://');
  await page.clock.runFor(1000);
  expect(urls).toEqual([]);
  await input.fill('https://shop.example.com/shoe');
  await page.clock.runFor(300);
  await input.fill('https://shop.example.com/shoes?color=purple');
  await page.clock.runFor(300);
  expect(urls).toEqual([]);
  await page.clock.runFor(100);
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveValue('Shoes');
  expect(urls).toEqual(['https://shop.example.com/shoes?color=purple']);
  await add.getByLabel('Gift URL').fill('https://shop.example.com/edited');
  await page.clock.runFor(1000);
  expect(urls).toHaveLength(1);
});

test('the three-second cutoff opens the form once and ignores late results', async ({ page }) => {
  const add = await openList(page);
  await page.clock.install();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let completed!: () => void;
  const done = new Promise<void>(resolve => { completed = resolve; });
  await page.route('**/api/lists/*/gift-suggestion', async route => {
    await pending;
    await route.fulfill({ json: { draft: { name: 'Too late', url: 'https://shop.example.com/other', image: '', price: '999' } } });
    completed();
  });
  await add.getByLabel('Gift URL').fill('https://shop.example.com/shoes');
  await page.clock.runFor(400);
  await expect(add.getByRole('status')).toContainText('Checking');
  await page.clock.runFor(2500);
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveCount(0);
  await page.clock.runFor(500);
  await expect(add.getByRole('status')).toContainText('took too long');
  await add.getByLabel('Gift name', { exact: true }).fill('Keep my work');
  release(); await done;
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveValue('Keep my work');
  await expect(add.getByLabel('Gift URL')).toHaveValue('https://shop.example.com/shoes');
  await expect(add.getByLabel('Price in dollars')).toHaveValue('');
});
