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

export interface Notifier {
  sendPrivate(userId: string, msg: { text: string; blocks?: SlackBlock[] }): Promise<SentMessage>;
  postInThread(msg: { channel: string; threadTs: string; text: string }): Promise<SentMessage>;
  update(ref: SentMessage, msg: { text: string; blocks?: SlackBlock[] }): Promise<void>;
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
