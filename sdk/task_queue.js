/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — Task Queue
 *
 *  Manages multi-agent tasks stored as vault nodes (type: 'task').
 *  Works via the brain REST API so it is decoupled from the FS.
 *
 *  Task node tags encode status:
 *    [task, pending]   → waiting for a coordinator/dispatcher
 *    [task, running]   → being processed
 *    [task, completed] → done
 *    [task, failed]    → errored
 *    [task, blocked]   → waiting on unresolved dependencies
 *    [task, cancelled] → cancelled by user
 *
 *  This is a lightweight coordination primitive — a shared, auditable
 *  markdown task list with dependency-based blocking — not a full
 *  autonomous multi-agent orchestrator. Whatever actually watches
 *  `pending` tasks and does the work is left to the caller.
 * ══════════════════════════════════════════════════════════════
 */

import { SecondBrain } from './index.js';

const STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'blocked'];

export class TaskQueue {
  constructor(options = {}) {
    this.brain = new SecondBrain({
      agent: 'task-queue',
      api: options.api,
      apiKey: options.apiKey,
      silent: options.silent ?? true,
    });
  }

  // ── Create ────────────────────────────────────────────────────
  /**
   * Submit a new multi-agent task.
   * @param {string}   prompt               - The task/goal description
   * @param {string[]} agents               - Agent names to involve directly
   * @param {object}   opts
   * @param {number}   opts.priority         - 1-10 (default 5)
   * @param {string}   opts.title            - Short title (auto-generated if omitted)
   * @param {string[]} opts.tags             - Extra tags
   * @param {string[]} opts.dependencies     - Array of dependency nodeIds
   * @returns {Promise<{taskId, nodeId, status}>}
   */
  async submit(prompt, agents = [], opts = {}) {
    const taskId      = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    // No ":" (or any other filename-invalid character) in the default title
    // — brain_engine.js's validateNode rejects a title containing one
    // outright (it enforces filename safety pre-write, ahead of writeNode's
    // own sanitization), so "Task: <prompt>" would fail validation on every
    // submit that didn't pass an explicit opts.title.
    const title       = opts.title || `Task - ${prompt.slice(0, 60).replace(/\n/g, ' ')}`;
    const priority    = opts.priority ?? 5;
    // Falls back to a generic 'coordinator' agent when no specific agent was
    // named — the caller can always name real agents explicitly instead.
    const agentList   = agents.length ? agents : ['coordinator'];
    const deps        = (opts.dependencies || []).filter(Boolean);
    const status      = deps.length > 0 ? 'blocked' : 'pending';

    const content = [
      `taskId: ${taskId}`,
      `status: ${status}`,
      `priority: ${priority}`,
      agentList.length ? `assignedAgents: ${agentList.join(', ')}` : null,
      deps.length ? `dependencies: ${deps.join(', ')}` : null,
      '',
      '## Prompt',
      prompt,
      '',
      '## Sub-Results',
      '',
      '## Final Result',
      '',
    ].filter(line => line !== null && line !== undefined).join('\n');

    const result = await this.brain.remember(content, {
      title,
      type: 'task',
      tags: ['task', status, ...(opts.tags || [])],
      subdir: 'tasks',
    });

    console.log(`[task-queue] Submitted: "${title}" (${taskId}) -> agents: ${agentList.join(', ')} [${status}]`);
    return { taskId, nodeId: result?.id, status };
  }

  // ── Read ──────────────────────────────────────────────────────
  /**
   * List tasks, optionally filtered by status.
   * @param {string|null} status - 'pending'|'running'|'completed'|'failed'|'blocked'|null (all)
   */
  async list(status = null) {
    const url = status ? `/tasks?status=${encodeURIComponent(status)}` : '/tasks';
    const result = await this.brain._fetch(url);
    return result?.tasks || [];
  }

  /**
   * List all blocked tasks waiting on dependencies.
   */
  async listBlocked() {
    return this.list('blocked');
  }

  /**
   * After a task completes (or fails), scan blocked tasks and release any
   * whose dependencies are now resolved: to 'pending' once ALL deps have
   * completed, or cascaded to 'failed' as soon as ANY dep has failed or been
   * cancelled — a dependency that failed will never complete, so leaving the
   * dependent 'blocked' forever would silently wedge the rest of the plan
   * with no way to recover except manual intervention.
   * @param {string} completedNodeId - The nodeId of the just-completed/failed task
   */
  async releaseDependents(completedNodeId) {
    let released = 0;
    try {
      const blocked = await this.listBlocked();
      for (const node of blocked) {
        const content = node.content || '';
        const depsMatch = content.match(/dependencies:\s*(.+)/);
        if (!depsMatch) continue;

        const depNodeIds = depsMatch[1].split(',').map(s => s.trim()).filter(Boolean);
        if (!depNodeIds.includes(completedNodeId)) continue;

        const depNodes = await Promise.all(depNodeIds.map(async depId => {
          try { return await this.get(depId); } catch { return null; }
        }));
        const depTags = depNodes.map(n => n?.tags || []);

        if (depTags.some(tags => tags.includes('failed') || tags.includes('cancelled'))) {
          console.log(`[task-queue] Cascading failure to blocked task: "${node.title}" (a dependency failed)`);
          await this.setStatus(node.id, 'failed', {
            content: `${node.content || ''}\n\n## Error\nCancelled automatically — a dependency failed or was cancelled.\n`,
          });
          released++;
        } else if (depTags.every(tags => tags.includes('completed'))) {
          console.log(`[task-queue] Releasing blocked task: "${node.title}" (all deps complete)`);
          await this.setStatus(node.id, 'pending');
          released++;
        }
      }
    } catch (err) {
      console.warn(`[task-queue] releaseDependents failed: ${err.message}`);
    }
    return released;
  }

  /**
   * Get full details of a single task.
   */
  async get(nodeId) {
    return await this.brain.get(nodeId);
  }

  // ── Update ────────────────────────────────────────────────────
  /**
   * Transition a task to a new status.
   * @param {string} nodeId
   * @param {string} newStatus  - 'running'|'completed'|'failed'|'cancelled'
   * @param {object} patch      - optional { content } to merge into task body
   */
  async setStatus(nodeId, newStatus, patch = {}) {
    if (!STATUSES.includes(newStatus)) throw new Error(`Unknown status: ${newStatus}`);

    const node = await this.get(nodeId);
    if (!node) throw new Error(`Task not found: ${nodeId}`);

    const newTags = ['task', newStatus,
      ...(node.tags || []).filter(t => !STATUSES.includes(t) && t !== 'task')];

    // The tags array is the source of truth for status, but the note also
    // carries a human-readable "status: xxx" line from submit() — keep it in
    // sync so a raw read of the file (Obsidian, a peer parsing the content)
    // doesn't see a stale "pending" on a long-completed task.
    const baseContent = patch.content !== undefined ? patch.content : node.content;
    const newContent = (baseContent || '').replace(/^status:\s*\S+/m, `status: ${newStatus}`);

    return await this.brain.update(nodeId, {
      tags: newTags,
      content: newContent,
    });
  }

  /**
   * Append a sub-agent's result to the task node content.
   * @param {string} nodeId
   * @param {string} agentName
   * @param {string} result     - Markdown result text
   */
  async appendResult(nodeId, agentName, result) {
    const node = await this.get(nodeId);
    if (!node) return;

    const marker  = '## Sub-Results';
    const content  = node.content || '';
    const idx      = content.indexOf(marker);
    const section  = `\n### ${agentName}\n${result}\n`;

    let newContent;
    if (idx !== -1) {
      newContent = content.slice(0, idx + marker.length) + section + content.slice(idx + marker.length);
    } else {
      newContent = content + '\n## Sub-Results\n' + section;
    }

    return await this.brain.update(nodeId, { content: newContent });
  }

  /**
   * Write the final aggregated result to the task node.
   */
  async setFinalResult(nodeId, finalResult) {
    const node = await this.get(nodeId);
    if (!node) return;

    const marker   = '## Final Result';
    const content   = node.content || '';
    const idx       = content.indexOf(marker);
    const section   = `\n${finalResult}\n`;

    let newContent;
    if (idx !== -1) {
      newContent = content.slice(0, idx + marker.length) + section;
    } else {
      newContent = content + '\n## Final Result\n' + section;
    }
    return await this.brain.update(nodeId, { content: newContent });
  }

  /**
   * Cancel a pending or running task.
   */
  async cancel(nodeId) {
    return await this.setStatus(nodeId, 'cancelled');
  }
}

export default TaskQueue;
