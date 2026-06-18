import type { Notifier, SentMessage } from "../slack/notifier.js";
import type { SlackBlock } from "../slack/blocks.js";

/** Minimal structural view of the Slack Web client methods Kept uses. */
export interface SlackClientLike {
  chat: {
    postMessage(args: { channel: string; text: string; blocks?: unknown; thread_ts?: string }): Promise<{ ts?: string; channel?: string }>;
    update(args: { channel: string; ts: string; text: string; blocks?: unknown }): Promise<unknown>;
  };
  conversations: {
    open(args: { users: string }): Promise<{ channel?: { id?: string } }>;
  };
}

/**
 * Production notifier on the Slack Web API. sendPrivate DMs the internal owner;
 * postInThread posts the (already-sanitized, human-approved) closure into the
 * original customer thread.
 */
export class SlackNotifier implements Notifier {
  constructor(private readonly client: SlackClientLike) {}

  async sendPrivate(userId: string, msg: { text: string; blocks?: SlackBlock[] }): Promise<SentMessage> {
    const opened = await this.client.conversations.open({ users: userId });
    const channel = opened.channel?.id ?? userId;
    const res = await this.client.chat.postMessage({ channel, text: msg.text, blocks: msg.blocks });
    return { ref: `${channel}:${res.ts ?? ""}`, channel, ts: res.ts };
  }

  async postInThread(msg: { channel: string; threadTs: string; text: string }): Promise<SentMessage> {
    const res = await this.client.chat.postMessage({ channel: msg.channel, thread_ts: msg.threadTs, text: msg.text });
    return { ref: `${msg.channel}:${res.ts ?? ""}`, channel: msg.channel, ts: res.ts };
  }

  async update(ref: SentMessage, msg: { text: string; blocks?: SlackBlock[] }): Promise<void> {
    const [channel, ts] = ref.ref.split(":");
    await this.client.chat.update({ channel, ts, text: msg.text, blocks: msg.blocks });
  }
}
