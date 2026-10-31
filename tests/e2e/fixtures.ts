import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';

// Each file/project gets a fresh daily allowance in the local simulated DB.
// Keep quota enforcement active; tests must not depend on earlier local runs.
test.beforeAll(() => {
  execFileSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.jsonc',
    '--persist-to', process.env.GIMME_LOCAL_STATE_DIR!,
    '--command', "UPDATE list_creation_budget SET day = '', attempts = 0; UPDATE image_budget SET upload_day = '', uploads = 0, upload_bytes = 0, read_day = '', reads = 0;",
  ], { stdio: 'pipe' });
});

export { test, expect };
