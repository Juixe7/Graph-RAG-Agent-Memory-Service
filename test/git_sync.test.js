import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createGitSync } from '../sdk/git_sync.js';

// Real git commands against a real temp repo (with a local bare "remote"),
// not mocked — the whole point of this suite is to catch a bad `git add`
// pathspec or command-construction bug by running the real command.
function initRepoWithRemote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-gitsync-test-'));
  const bareRemote = path.join(root, 'remote.git');
  const workDir = path.join(root, 'work');
  const vaultDir = path.join(workDir, 'vault');

  execSync(`git init --bare "${bareRemote}"`, { stdio: 'ignore' });
  fs.mkdirSync(vaultDir, { recursive: true });
  execSync('git init', { cwd: workDir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: workDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: workDir, stdio: 'ignore' });
  execSync('git config commit.gpgsign false', { cwd: workDir, stdio: 'ignore' });
  execSync(`git remote add origin "${bareRemote}"`, { cwd: workDir, stdio: 'ignore' });
  execSync('git checkout -b main', { cwd: workDir, stdio: 'ignore' });

  fs.writeFileSync(path.join(vaultDir, '.gitkeep'), '');
  execSync('git add -A', { cwd: workDir, stdio: 'ignore' });
  execSync('git commit -m "initial"', { cwd: workDir, stdio: 'ignore' });
  execSync('git push -u origin main', { cwd: workDir, stdio: 'ignore' });

  return { workDir, vaultDir };
}

test('gitSync stages only the specific paths given, leaving unrelated pending changes uncommitted', async () => {
  const { workDir, vaultDir } = initRepoWithRemote();
  const { gitSync } = createGitSync(vaultDir, { enabled: true });

  fs.writeFileSync(path.join(vaultDir, 'intended.md'), '# Intended change\n');
  fs.writeFileSync(path.join(vaultDir, 'unrelated.md'), '# Unrelated in-progress edit\n');

  const result = await gitSync('add intended note', ['intended.md']);
  assert.equal(result.error, null, `sync should succeed: ${result.error}`);

  const status = execSync('git status --porcelain', { cwd: workDir }).toString();
  assert.ok(!status.includes('intended.md'), 'the specifically-staged file should be committed, not pending');
  assert.ok(status.includes('unrelated.md'), 'an unrelated uncommitted file must NOT be swept into the commit');

  const log = execSync('git log --oneline -1', { cwd: workDir }).toString();
  assert.match(log, /add intended note/);
});

test('gitSync never stages the embeddings cache, even if it happens to exist on disk', async () => {
  // The cache (.embeddings.db) is gitignored (regenerable, not vault
  // content) — this only matters if a real .gitignore is present in the
  // repo, which the temp repo here deliberately doesn't have, so this
  // specifically checks gitSync's OWN behavior: it must never explicitly
  // add a path the caller didn't ask for, full stop, regardless of ignore
  // rules.
  const { workDir, vaultDir } = initRepoWithRemote();
  const { gitSync } = createGitSync(vaultDir, { enabled: true });

  fs.writeFileSync(path.join(vaultDir, '.embeddings.db'), 'not real sqlite, just a stand-in for the test');
  fs.writeFileSync(path.join(vaultDir, 'a.md'), '# A\n');
  const result = await gitSync('add a', ['a.md']);
  assert.equal(result.error, null);

  const status = execSync('git status --porcelain', { cwd: workDir }).toString();
  assert.ok(status.includes('.embeddings.db'), 'the embeddings cache must stay uncommitted unless a caller explicitly asks for it');
});

test('gitSync coalesces a call that arrives while a sync is already running', async () => {
  const { workDir, vaultDir } = initRepoWithRemote();
  const { gitSync } = createGitSync(vaultDir, { enabled: true });

  fs.writeFileSync(path.join(vaultDir, 'x.md'), '# X\n');
  fs.writeFileSync(path.join(vaultDir, 'y.md'), '# Y\n');

  const first = gitSync('first message', ['x.md']);
  const second = gitSync('second message', ['y.md']); // arrives synchronously while `first` is already in flight
  assert.equal(second, undefined, 'a coalesced call returns nothing — it is absorbed into the running sync, not run independently');

  await first;

  const status = execSync('git status --porcelain', { cwd: workDir }).toString();
  assert.equal(status.trim(), '', 'both files should end up committed even though only one gitSync call was "in flight" when the second one queued');
});

test('gitSync is a no-op when disabled', () => {
  const { vaultDir } = initRepoWithRemote();
  const { gitSync } = createGitSync(vaultDir, { enabled: false });
  fs.writeFileSync(path.join(vaultDir, 'never-synced.md'), '# nope\n');
  const result = gitSync('should not run', ['never-synced.md']);
  assert.equal(result, undefined);
});
