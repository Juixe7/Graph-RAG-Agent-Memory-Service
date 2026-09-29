/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — Agent Messenger
 *
 *  Agent-to-agent messaging backed by vault nodes (type: 'message').
 *  Messages are stored as markdown files with frontmatter encoding
 *  sender, recipient, status, and an optional linked taskId.
 *
 *  Flow:
 *    Agent A -> send(to='qa-agent', content)  -> vault note created
 *    Agent B -> inbox('qa-agent')             -> reads unread messages
 *    Agent B -> reply(msgId, response)        -> new message + markRead
 *
 *  A lightweight coordination primitive (a shared inbox/outbox), not a
 *  full messaging system — no delivery guarantees beyond "it's a file
 *  in the vault," which is enough for a small swarm of cooperating
 *  agents that already share this vault.
 * ══════════════════════════════════════════════════════════════
 */

import { SecondBrain } from './index.js';

export class Messenger {
  constructor(options = {}) {
    this.brain = new SecondBrain({
      agent: 'messenger',
      api: options.api,
      apiKey: options.apiKey,
      silent: options.silent ?? true,
    });
  }

  // ── Send ──────────────────────────────────────────────────────
  /**
   * Send a message from one agent to another.
   * @param {string}      fromAgent - Sending agent name
   * @param {string}      toAgent   - Receiving agent name
   * @param {string}      content   - Message body (markdown)
   * @param {object}      opts
   * @param {string}      opts.taskId    - Associated task ID
   * @param {string}      opts.subject   - Message subject
   * @param {string}      opts.replyToId - Node ID of message being replied to
   * @returns {Promise<{id}>}
   */
  async send(fromAgent, toAgent, content, opts = {}) {
    const subject  = opts.subject || `Message from ${fromAgent}`;
    const agentSlug = toAgent.toLowerCase().replace(/\s+/g, '-');

    const msgContent = [
      opts.taskId    ? `**Task:** ${opts.taskId}` : '',
      opts.replyToId ? `**Reply-To:** ${opts.replyToId}` : '',
      '',
      content,
    ].filter(Boolean).join('\n');

    const result = await this.brain.remember(msgContent, {
      title:   `[MSG] ${subject}`,
      type:    'message',
      tags:    ['message', 'unread', `to-${agentSlug}`, `from-${fromAgent.toLowerCase().replace(/\s+/g, '-')}`],
      subdir:  `messages/${agentSlug}`,
    });

    console.log(`[messenger] ${fromAgent} -> ${toAgent}: "${subject}"`);
    return result;
  }

  // ── Inbox ─────────────────────────────────────────────────────
  /**
   * Read messages addressed to a specific agent.
   * @param {string}  agentName  - Recipient agent name
   * @param {boolean} unreadOnly - Return only unread messages (default true)
   */
  async inbox(agentName, unreadOnly = true) {
    const agentSlug = agentName.toLowerCase().replace(/\s+/g, '-');
    const tag       = `to-${agentSlug}`;
    const messages  = await this.brain.byTag(tag);

    if (unreadOnly) {
      return messages.filter(m => m.tags.includes('unread'));
    }
    return messages;
  }

  /**
   * Read all sent messages from a specific agent.
   */
  async sent(agentName) {
    const agentSlug = agentName.toLowerCase().replace(/\s+/g, '-');
    const tag       = `from-${agentSlug}`;
    return await this.brain.byTag(tag);
  }

  // ── Mark read ─────────────────────────────────────────────────
  /**
   * Mark a message as read.
   */
  async markRead(nodeId) {
    const node = await this.brain.get(nodeId);
    if (!node) return;
    const newTags = node.tags
      .filter(t => t !== 'unread')
      .concat('read');
    return await this.brain.update(nodeId, { tags: newTags });
  }

  /**
   * Mark a message as replied.
   */
  async markReplied(nodeId) {
    const node = await this.brain.get(nodeId);
    if (!node) return;
    const newTags = node.tags
      .filter(t => t !== 'unread' && t !== 'read')
      .concat('replied');
    return await this.brain.update(nodeId, { tags: newTags });
  }

  // ── Reply ─────────────────────────────────────────────────────
  /**
   * Reply to a message. Marks original as replied and creates a new message.
   */
  async reply(originalNodeId, fromAgent, content, opts = {}) {
    const original = await this.brain.get(originalNodeId);
    if (!original) throw new Error(`Message not found: ${originalNodeId}`);

    // Extract original sender from tags (from-<slug>)
    const fromTag = original.tags.find(t => t.startsWith('from-'));
    const originalSender = fromTag ? fromTag.replace('from-', '').replace(/-/g, ' ') : 'unknown';

    // Send reply
    const result = await this.send(fromAgent, originalSender, content, {
      ...opts,
      subject:   `Re: ${original.title.replace('[MSG] ', '')}`,
      replyToId: originalNodeId,
    });

    // Mark original as replied
    await this.markReplied(originalNodeId);

    return result;
  }
}

export default Messenger;
