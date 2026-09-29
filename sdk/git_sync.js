/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — Vault Git Sync
 *
 *  Auto-commits and pushes SPECIFIC vault file changes after a write,
 *  serialized so concurrent writes don't race on .git/index.lock (a
 *  single busy swarm task can trigger several writes within a second).
 *
 *  Deliberately stages only the paths the caller says changed, never the
 *  whole vault folder — `git add <wholeVault>` sweeps up ANY other
 *  unrelated in-progress edit sitting uncommitted at that moment into
 *  whatever commit fires next, bundling unrelated in-flight edits under a
 *  confusingly unrelated commit message. See test/git_sync.test.js for the
 *  regression test this guards against.
 * ══════════════════════════════════════════════════════════════
 */
import path from 'path';
import { exec as defaultExec } from 'child_process';

/**
 * @param {string} vaultDir - absolute path to the vault folder
 * @param {object} [options]
 * @param {boolean} [options.enabled] - if false, gitSync() is a no-op (matches AUTO_GIT_SYNC)
 * @param {Function} [options.exec] - injectable in place of child_process.exec, for tests
 * @param {Function} [options.onError] - (err, command) => void, called when a sync fails
 * @param {Function} [options.onSuccess] - (message) => void, called when a sync succeeds
 */
export function createGitSync(vaultDir, options = {}) {
  const runExec = options.exec || defaultExec;
  const enabled = options.enabled ?? true;
  let busy = false;
  let queued = null; // { message, paths: Set<string> } | null

  // Absolute filesystem path -> path relative to the vault folder, suitable
  // for `git add <vaultFolderName>/<this>`.
  function toVaultRelativePath(absPath) {
    return path.relative(vaultDir, absPath).replace(/\\/g, '/');
  }

  function runSync(message, paths) {
    busy = true;
    const vaultFolderName = path.basename(vaultDir);
    // Note: the embedding cache (.embeddings.db) is deliberately NOT folded
    // in here — it's gitignored (regenerable from vault content), so
    // there's nothing to stage for it even if a caller asked.
    const addTargets = paths.length
      ? paths.map(p => `"${path.posix.join(vaultFolderName, p)}"`).join(' ')
      : `"${vaultFolderName}"`;
    const command = `git pull origin main && git add ${addTargets} && git commit -m "${message.replace(/"/g, '\\"')}" && git push origin main`;
    const projectRoot = path.resolve(vaultDir, '..');

    return new Promise((resolve) => {
      runExec(command, { cwd: projectRoot }, (err) => {
        busy = false;
        if (err) options.onError?.(err, command);
        else options.onSuccess?.(message);

        if (queued) {
          const next = queued;
          queued = null;
          runSync(next.message, [...next.paths]).then(resolve);
        } else {
          resolve({ error: err || null, command });
        }
      });
    });
  }

  /**
   * @param {string}   message
   * @param {string[]} [paths] - vault-relative paths (see toVaultRelativePath)
   *   of exactly what changed. Omitting this falls back to staging the
   *   whole vault folder — only appropriate for a caller that genuinely
   *   doesn't know which files moved.
   * @returns {Promise<{error, command}>|undefined} resolves once this sync
   *   (and any it absorbed while running) settles; production callers can
   *   ignore the return value, tests can await it.
   */
  function gitSync(message, paths) {
    if (!enabled) return;
    if (busy) {
      if (!queued) queued = { message, paths: new Set(paths || []) };
      else {
        queued.message = message; // last message wins
        for (const p of paths || []) queued.paths.add(p);
      }
      return;
    }
    return runSync(message, paths || []);
  }

  return { gitSync, toVaultRelativePath };
}
