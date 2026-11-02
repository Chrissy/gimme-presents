import { execFileSync } from 'node:child_process';
import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ signedIn: boolean; accessSetup: void }>({
  signedIn: [true, { option: true }],
  accessSetup: [async ({ page, signedIn }, use) => {
    resetLocalAllowances();
    if (signedIn) {
      const email = `${crypto.randomUUID()}@example.com`;
      const headers = { Origin: 'http://127.0.0.1:4173', 'X-Requested-With': 'gimme-presents' };
      const response = await page.request.post('/api/auth/request', { headers, data: { email, clientKey: crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') } });
      expect(response.status()).toBe(200);
      const inbox = await (await page.request.get('/api/local/mail')).json();
      const mail = inbox.messages.find((message: { to: string }) => message.to === email);
      const token = mail.text.match(/#token=([a-f0-9]{64})/)[1];
      expect((await page.request.post('/api/auth/confirm', { headers, data: { token } })).status()).toBe(200);
    }
    await use();
  }, { auto: true }],
});

// Each test gets a fresh daily allowance in the local simulated DB.
// Keep quota enforcement active; tests must not depend on earlier local runs.
function resetLocalAllowances() {
  execFileSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
    '--persist-to', process.env.GIMME_LOCAL_STATE_DIR!,
    '--command', "DELETE FROM email_rate; UPDATE list_creation_budget SET day = '', attempts = 0; UPDATE image_budget SET upload_day = '', uploads = 0, upload_bytes = 0, read_day = '', reads = 0;",
  ], { stdio: 'pipe' });
}

export { expect };
