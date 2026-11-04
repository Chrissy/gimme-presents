import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function openList(page: Page) {
  await page.goto('/');
  await page.getByLabel('List name', { exact: true }).fill('Things I definitely need');
  await page.getByRole('link', { name: 'create my list!' }).click();
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  return page.getByRole('complementary', { name: 'Add a gift' });
}

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
  await add.getByLabel('Gift URL', { exact: true }).press('Enter');
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveValue('a mug for my personality substitute');
  await expect(add.getByLabel('Price in dollars')).toHaveValue('24.50');
  await expect(add.getByRole('img', { name: 'Image preview' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('gift-draft.png'), fullPage: true });
  await add.getByLabel('Gift name', { exact: true }).fill('The mug I actually want');
  await add.getByLabel('Price in dollars').fill('22');
  await add.getByRole('button', { name: 'Remove image' }).click();
  await add.getByRole('link', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article', { name: 'The mug I actually want' })).toContainText('$22.00');
  await expect(add.getByRole('link', { name: 'fill in my gift!' })).toBeVisible();
  await expect(add.getByLabel('Gift URL')).toHaveValue('');
  expect(calls).toBe(1);
});

test('limits reveal the manual form without losing the URL', async ({ page }, info) => {
  const add = await openList(page);
  await page.route('**/api/lists/*/gift-suggestion', route => route.fulfill({ status: 429, json: { error: 'Gift suggestions have reached a usage limit. You can still add gifts manually.' } }));
  await add.getByLabel('Gift URL').fill('https://shop.example.com/shoes');
  await add.getByRole('link', { name: 'fill in my gift!' }).click();
  await expect(add.getByLabel('Gift URL')).toHaveValue('https://shop.example.com/shoes');
  await expect(add.getByRole('status')).toContainText('manually');
  await add.getByLabel('Gift name', { exact: true }).fill('Shoes');
  await page.screenshot({ path: info.outputPath('gift-manual-fallback.png'), fullPage: true });
  await add.getByRole('link', { name: 'create my gift!' }).click();
  await expect(page.getByRole('article', { name: 'Shoes' })).toBeVisible();
});

test('manual entry cancels a pending suggestion and late results cannot overwrite edits', async ({ page }) => {
  const add = await openList(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let completed!: () => void;
  const done = new Promise<void>(resolve => { completed = resolve; });
  await page.route('**/api/lists/*/gift-suggestion', async route => {
    await pending;
    await route.fulfill({ json: { draft: { name: 'Late answer', url: 'https://shop.example.com/other', image: '', price: '999' } } });
    completed();
  });
  await add.getByLabel('Gift URL').fill('https://shop.example.com/shoes');
  await add.getByRole('link', { name: 'fill in my gift!' }).click();
  await expect(add.getByRole('status')).toContainText('Checking');
  await add.getByRole('button', { name: 'add manually' }).click();
  await add.getByLabel('Gift name', { exact: true }).fill('Keep my title');
  release(); await done;
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveValue('Keep my title');
  await expect(add.getByLabel('Gift URL')).toHaveValue('https://shop.example.com/shoes');
  await expect(add.getByLabel('Price in dollars')).toHaveValue('');
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
  await add.getByRole('link', { name: 'fill in my gift!' }).click();
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
