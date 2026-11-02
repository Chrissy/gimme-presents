import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProductionRelease } from '../scripts/check-production-release.mjs';

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'gimme-release-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const cwd = join(root, 'checkout');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, cwd], { stdio: 'pipe' });
  git('config', 'user.name', 'Release guard test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(cwd, 'app.txt'), 'reviewed code');
  git('add', 'app.txt'); git('commit', '-m', 'Reviewed release'); git('push', 'origin', 'main');
  return { cwd, git };
}

test('accepts a clean checkout at the exact fetched main commit', t => {
  const { cwd, git } = repository(t);
  git('checkout', '--detach');
  assert.equal(checkProductionRelease(cwd), git('rev-parse', 'HEAD'));
});

test('rejects an unmerged feature commit', t => {
  const { cwd, git } = repository(t);
  git('checkout', '-b', 'codex/unreviewed');
  writeFileSync(join(cwd, 'app.txt'), 'unreviewed code');
  git('commit', '-am', 'New feature');
  assert.throws(() => checkProductionRelease(cwd), /not latest origin\/main/);
});

test('rejects tracked local edits', t => {
  const { cwd } = repository(t);
  writeFileSync(join(cwd, 'app.txt'), 'local change');
  assert.throws(() => checkProductionRelease(cwd), /commit or remove local changes/);
});

test('rejects untracked application code', t => {
  const { cwd } = repository(t);
  writeFileSync(join(cwd, 'new-code.js'), 'unreviewed');
  assert.throws(() => checkProductionRelease(cwd), /commit or remove local changes/);
});

test('refreshes main and rejects an older released commit', t => {
  const { cwd, git } = repository(t);
  const previous = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'app.txt'), 'new reviewed release');
  git('commit', '-am', 'Next release'); git('push', 'origin', 'main');
  git('checkout', '--detach', previous);
  git('update-ref', 'refs/remotes/origin/main', previous);
  assert.throws(() => checkProductionRelease(cwd), /not latest origin\/main/);
});

test('fails closed when the remote cannot be checked', t => {
  const { cwd, git } = repository(t);
  git('remote', 'set-url', 'origin', join(cwd, 'missing.git'));
  assert.throws(() => checkProductionRelease(cwd));
});
