import { test, expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import type { APIRequestContext } from '@playwright/test';

test.use({ signedIn: false });
const headers = { Origin: 'http://127.0.0.1:4173', 'X-Requested-With': 'gimme-presents' };
async function emailLink(request: APIRequestContext, email: string) {
  const inbox = await (await request.get('/api/local/mail')).json();
  const message = inbox.messages.find((mail: { to: string }) => mail.to === email);
  expect(message).toBeTruthy();
  return message.text.match(/http[^\s]+#token=[a-f0-9]+/)[0] as string;
}
function resetEmailAllowance() {
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc', '--persist-to', process.env.GIMME_LOCAL_STATE_DIR!, '--command', 'DELETE FROM email_rate;'], { stdio: 'pipe' });
}

test('name, email, inbox, and explicit confirmation create one list in the receiving browser', async ({ page, browser }, info) => {
  const email = `${crypto.randomUUID()}@example.com`;
  await page.goto('/');
  await page.getByLabel('List name', { exact: true }).fill('Winter wishes');
  await page.getByRole('link', { name: 'create my list!' }).click();
  await expect(page.getByRole('heading', { name: 'email me about my stupid list', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('email-entry.png'), fullPage: true });
  await page.getByLabel('Your email').fill(email);
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Resend in/ })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('check-email.png'), fullPage: true });
  const link = await emailLink(page.request, email);
  const recipient = await browser.newContext({ viewport: info.project.use.viewport });
  const receiver = await recipient.newPage();
  await receiver.goto(link);
  await expect(receiver.getByRole('button', { name: "click this dumb button to prove you aren't a robot" })).toBeVisible();
  expect((await (await page.request.get('/api/me')).json()).verified).toBe(false);
  await receiver.screenshot({ path: info.outputPath('email-confirmation.png'), fullPage: true });
  await receiver.getByRole('button', { name: "click this dumb button to prove you aren't a robot", exact: true }).click();
  await expect(receiver.getByRole('heading', { level: 1 })).toHaveAccessibleName(/^Winter wishes/);
  await expect(receiver.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  const listUrl = receiver.url();
  expect((await (await page.request.get('/api/me')).json()).verified).toBe(false);
  await receiver.goto('/');
  await receiver.getByLabel('List name', { exact: true }).fill('Another occasion');
  await receiver.getByRole('link', { name: 'create my list!' }).click();
  await expect(receiver.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  expect((await (await receiver.request.get('/api/me')).json()).lists).toHaveLength(2);
  // The original proof cannot create another list or sign in another browser.
  await page.goto(link);
  await expect(page.getByRole('alert')).toContainText('already used');
  await expect(page.getByRole('button', { name: "click this dumb button to prove you aren't a robot", exact: true })).toHaveCount(0);
  await page.goto(listUrl);
  await expect(page.getByRole('link', { name: 'Is this your list? Restore editing access' })).toBeVisible();
  await recipient.close();
});

test('a fresh email after cookies are cleared recovers the same lists and creates the pending list', async ({ page, context }) => {
  const email = `${crypto.randomUUID()}@example.com`;
  await page.goto('/');
  await page.getByLabel('List name', { exact: true }).fill('First year');
  await page.getByRole('link', { name: 'create my list!' }).click();
  await page.getByLabel('Your email').fill(email);
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await emailLink(page.request, email));
  await page.getByRole('button', { name: "click this dumb button to prove you aren't a robot", exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add a sweet present!' })).toBeVisible();
  await context.clearCookies(); resetEmailAllowance();
  await page.goto('/');
  await page.getByLabel('List name', { exact: true }).fill('Next year');
  await page.getByRole('link', { name: 'create my list!' }).click();
  await page.getByLabel('Your email').fill(email);
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await emailLink(page.request, email));
  await page.getByRole('button', { name: "click this dumb button to prove you aren't a robot", exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(/^Next year/);
  expect((await (await page.request.get('/api/me')).json()).lists.map((list: { name: string }) => list.name).sort()).toEqual(['First year', 'Next year']);
});

test('correcting an email invalidates the earlier link and preserves the list name', async ({ page }) => {
  const wrong = `${crypto.randomUUID()}@example.com`; const correct = `${crypto.randomUUID()}@example.com`;
  await page.goto('/');
  await page.getByLabel('List name', { exact: true }).fill('Keep this name');
  await page.getByRole('link', { name: 'create my list!' }).click();
  await page.getByLabel('Your email').fill(wrong);
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const oldLink = await emailLink(page.request, wrong);
  await page.getByRole('button', { name: 'Change email' }).click();
  await expect(page.getByRole('heading', { name: 'email me about my stupid list' })).toBeVisible();
  await page.getByLabel('Your email').fill(correct);
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = await emailLink(page.request, correct);
  await page.goto(oldLink);
  await expect(page.getByRole('alert')).toContainText('expired');
  await page.goto(link);
  await page.getByRole('button', { name: "click this dumb button to prove you aren't a robot" }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(/^Keep this name/);
});

test('recovery and request errors remain usable without losing entered fields', async ({ page }, info) => {
  await page.goto('/auth/recover');
  await page.getByLabel('Your email').fill('retry@example.com');
  await page.route('**/api/auth/request', route => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Please wait before requesting another email.' }) }));
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByRole('alert')).toContainText('Please wait');
  await expect(page.getByLabel('Your email')).toHaveValue('retry@example.com');
  await expect(page.getByRole('button', { name: 'Send email' })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('recovery-error.png'), fullPage: true });
  await page.goto('/auth/access#token=bad');
  await expect(page.getByRole('alert')).toContainText('invalid or expired');
  await expect(page.getByRole('link', { name: 'Get a fresh access link' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('expired-link.png'), fullPage: true });
});
