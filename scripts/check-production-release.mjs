import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkProductionRelease(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  }).trim();
  if (git('status', '--porcelain')) {
    throw new Error('Production deploy blocked: commit or remove local changes first, then deploy the reviewed merge commit.');
  }
  // Fetch the explicit branch into its tracking ref; stale refs must not pass.
  git('fetch', 'origin', '+refs/heads/master:refs/remotes/origin/master');
  const head = git('rev-parse', 'HEAD');
  const main = git('rev-parse', 'refs/remotes/origin/master');
  if (head !== main) {
    throw new Error(`Production deploy blocked: HEAD ${head} is not latest origin/master ${main}. Deploy only the reviewed, merged commit after user approval.`);
  }
  return head;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Production source verified: ${checkProductionRelease()}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
