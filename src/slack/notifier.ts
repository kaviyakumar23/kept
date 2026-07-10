import type { SlackBlock } from "./blocks.js";

/**
 * The output surface. Two channels with very different audiences:
 *  - sendPrivate: internal owner only (confirm cards, verify cards, nudges) — the
 *    "no public noise" invariant (D3). Never the shared customer channel.
 *  - postInThread: the customer-facing closure, in the ORIGINAL thread, only after
 *    human approval and only with sanitized text.
 */
export interface SentMessage {
  ref: string;
  channel?: string;
  ts?: string;
  permalink?: string;
}

/**
 * The output surface. In multi-workspace OAuth mode (W2) an out-of-band send (a
 * reminder, or a webhook-driven closure) has no Slack event context, so the acting
 * workspace's `team` id is threaded through and the notifier resolves that tenant's
 * bot token. In single-token / Socket Mode `team` is ignored (one captured client).
 */
export interface Notifier {
  sendPrivate(userId: string, msg: { text: string; blocks?: SlackBlock[] }, team?: string): Promise<SentMessage>;
  /**
   * Owner-only ephemeral, in a channel the owner is in — the audience-safe fallback for the
   * internal card when a real DM can't be opened (token lacks mpim:write). Visible ONLY to
   * `userId`; never seen by the rest of the channel.
   */
  postEphemeral(channel: string, userId: string, msg: { text: string; blocks?: SlackBlock[] }, team?: string): Promise<SentMessage>;
  postInThread(msg: { channel: string; threadTs: string; text: string }, team?: string): Promise<SentMessage>;
  update(ref: SentMessage, msg: { text: string; blocks?: SlackBlock[] }, team?: string): Promise<void>;
}

export interface RecordedCall {
  kind: "private" | "thread" | "update";
  to?: string;
  channel?: string;
  threadTs?: string;
  text: string;
  blocks?: SlackBlock[];
}

/** Records every notification for tests and the demo (no Slack required). */
export class RecordingNotifier implements Notifier {
  readonly calls: RecordedCall[] = [];
  private seq = 0;

  async sendPrivate(userId: string, msg: { text: string; blocks?: SlackBlock[] }): Promise<SentMessage> {
    this.calls.push({ kind: "private", to: userId, text: msg.text, blocks: msg.blocks });
    return { ref: `priv_${this.seq++}`, channel: userId };
  }
  async postEphemeral(channel: string, userId: string, msg: { text: string; blocks?: SlackBlock[] }): Promise<SentMessage> {
    // Owner-only ephemeral — recorded as private (never customer-facing text).
    this.calls.push({ kind: "private", to: userId, channel, text: msg.text, blocks: msg.blocks });
    return { ref: `ephem_${this.seq++}`, channel };
  }
  async postInThread(msg: { channel: string; threadTs: string; text: string }): Promise<SentMessage> {
    this.calls.push({ kind: "thread", channel: msg.channel, threadTs: msg.threadTs, text: msg.text });
    return { ref: `thread_${this.seq++}`, channel: msg.channel, ts: msg.threadTs, permalink: `https://slack/p/${msg.threadTs}` };
  }
  async update(ref: SentMessage, msg: { text: string; blocks?: SlackBlock[] }): Promise<void> {
    this.calls.push({ kind: "update", to: ref.ref, text: msg.text, blocks: msg.blocks });
  }

  /** All text ever sent to the shared customer channel (for leak assertions). */
  customerFacingText(): string[] {
    return this.calls.filter((c) => c.kind === "thread").map((c) => c.text);
  }
}
