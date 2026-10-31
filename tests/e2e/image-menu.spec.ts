import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { readFileSync } from 'node:fs';

async function createList(page: Page) {
  await page.goto('/');
  await page.getByLabel('List name', { exact: true }).fill('Image menu test');
  await page.getByRole('link', { name: 'create my list!' }).click();
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  return page.getByRole('complementary', { name: 'Add a gift' });
}

test('plus menu uploads a preview on save and supports editing and removal', async ({ page }, testInfo) => {
  const add = await createList(page);
  await expect(page.getByPlaceholder('Link to a photo')).toHaveCount(0);
  await expect(add.getByRole('textbox', { name: 'Image URL', exact: true })).toHaveCount(0);
  await add.getByRole('button', { name: 'Add image', exact: true }).click();
  await expect(add.getByRole('dialog', { name: 'Add image' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('image-menu.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(add.getByRole('dialog')).toHaveCount(0);
  await expect(add.getByRole('button', { name: 'Add image', exact: true })).toBeFocused();
  await add.getByRole('button', { name: 'Add image', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await add.getByRole('button', { name: 'Upload from device' }).click();
  await (await chooser).setFiles('public/edit.png');
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => add.getByRole('img', { name: 'Image preview' }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(13);
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('image-preview.png'), fullPage: true });

  // Failed gift validation retains the selected file for a retry.
  await add.getByRole('link', { name: 'create my gift!' }).click();
  await expect(add.getByRole('alert')).toContainText('gift name');
  await expect(add.getByRole('img', { name: 'Image preview' })).toBeVisible();
  await add.getByLabel('Gift name', { exact: true }).fill('Uploaded gift');
  await add.getByRole('link', { name: 'create my gift!' }).click();
  const article = page.getByRole('article', { name: 'Uploaded gift', exact: true });
  await expect(article.getByRole('img', { name: 'Uploaded gift', exact: true })).toHaveAttribute('src', /^\/media\//);
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('link', { name: 'Edit Uploaded gift', exact: true }).click();
  await expect(article.getByRole('img', { name: 'Image preview' })).toHaveAttribute('src', /^\/media\//);
  await article.getByLabel('Gift name', { exact: true }).fill('Renamed upload');
  await article.getByRole('link', { name: 'update my gift!' }).click();
  const renamed = page.getByRole('article', { name: 'Renamed upload', exact: true });
  await expect(renamed.getByRole('img', { name: 'Renamed upload', exact: true })).toHaveAttribute('src', /^\/media\//);
  await page.getByRole('link', { name: 'Edit Renamed upload', exact: true }).click();
  await renamed.getByRole('button', { name: 'Remove image' }).click();
  await renamed.getByRole('link', { name: 'update my gift!' }).click();
  await page.reload();
  await expect(renamed.locator('img')).not.toHaveAttribute('src');
});

test('URL entry lives in the plus menu, previews before save, and preserves a failed draft', async ({ page }) => {
  const add = await createList(page);
  await page.route('https://images.example.com/photo.png', route => route.fulfill({ path: 'public/edit.png', contentType: 'image/png' }));
  await add.getByRole('button', { name: 'Add image', exact: true }).click();
  await add.getByRole('button', { name: 'Paste image URL' }).click();
  await expect(add.getByRole('textbox', { name: 'Image URL', exact: true })).toBeFocused();
  await add.getByRole('textbox', { name: 'Image URL', exact: true }).fill('not a URL');
  await add.getByRole('textbox', { name: 'Image URL', exact: true }).press('Enter');
  await expect(add.getByRole('alert')).toContainText('valid HTTP');
  await add.getByRole('textbox', { name: 'Image URL', exact: true }).fill('https://images.example.com/photo.png');
  await add.getByRole('textbox', { name: 'Image URL', exact: true }).press('Enter');
  await expect(add.getByRole('dialog')).toHaveCount(0);
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveAttribute('src', 'https://images.example.com/photo.png');
  await expect(page.getByRole('article')).toHaveCount(0);
  await add.getByLabel('Gift name', { exact: true }).fill('Keep this draft');
  await page.route('**/api/lists/*/gifts', route => route.fulfill({ status: 422, json: { error: 'Couldn’t download that image. Try another image link.' } }));
  await add.getByRole('link', { name: 'create my gift!' }).click();
  await expect(add.getByRole('alert')).toContainText('Couldn’t download');
  await expect(add.getByLabel('Gift name', { exact: true })).toHaveValue('Keep this draft');
  await expect(add.getByRole('img', { name: 'Image preview' })).toBeVisible();
  await page.unroute('**/api/lists/*/gifts');
  await add.getByRole('button', { name: 'Replace image' }).click();
  await add.getByLabel('Gift name', { exact: true }).click();
  await expect(add.getByRole('dialog')).toHaveCount(0);
  await add.getByRole('button', { name: 'Remove image' }).click();
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveCount(0);
});

test('clipboard images use the same preview/upload flow and text paste stays untouched', async ({ page }) => {
  const add = await createList(page);
  const bytes = Array.from(readFileSync('public/edit.png'));
  const handled = await add.locator('form').evaluate((form, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'clipboard.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
    form.dispatchEvent(event);
    return event.defaultPrevented;
  }, bytes);
  expect(handled).toBe(true);
  await expect(add.getByRole('img', { name: 'Image preview' })).toBeVisible();
  const textHandled = await add.getByLabel('Gift name', { exact: true }).evaluate(input => {
    const data = new DataTransfer();
    data.setData('text/plain', 'ordinary text');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(textHandled).toBe(false);
  await add.getByLabel('Gift name', { exact: true }).fill('Clipboard gift');
  await add.getByRole('link', { name: 'create my gift!' }).click();
  await expect(page.getByRole('img', { name: 'Clipboard gift', exact: true })).toHaveAttribute('src', /^\/media\//);
});

test('invalid local files do not replace a selected image', async ({ page }) => {
  const add = await createList(page);
  const upload = add.getByLabel('Upload image', { exact: true });
  await upload.setInputFiles('public/edit.png');
  const preview = await add.getByRole('img', { name: 'Image preview' }).getAttribute('src');
  await upload.setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(add.getByRole('alert')).toContainText('PNG, JPEG, GIF, or WebP');
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveAttribute('src', preview!);
  await upload.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  await expect(add.getByRole('alert')).toContainText('up to 2 MiB');
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveAttribute('src', preview!);
  await add.locator('form').evaluate(form => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'clipboard.png', { type: 'image/png' }));
    form.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(add.getByRole('alert')).toContainText('up to 2 MiB');
  await expect(add.getByRole('img', { name: 'Image preview' })).toHaveAttribute('src', preview!);
});
