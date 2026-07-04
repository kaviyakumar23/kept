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

/** Resolve the Slack Web client for a workspace (W2 OAuth mode: install → bot token). */
export type ClientForTeam = (teamId: string) => Promise<SlackClientLike>;

/**
 * Production notifier on the Slack Web API. sendPrivate DMs the internal owner;
 * postInThread posts the (already-sanitized, human-approved) closure into the
 * original customer thread.
 *
 * W2 — multi-workspace: when a `clientForTeam` resolver is supplied (OAuth mode) and a
 * `team` is passed, the send uses that tenant's bot token. Otherwise it falls back to
 * the single captured client (single-token / Socket Mode), so the demo/dev path is
 * unchanged.
 */
export class SlackNotifier implements Notifier {
  constructor(
    private readonly client: SlackClientLike,
    private readonly clientForTeam?: ClientForTeam,
  ) {}

  private async resolve(team?: string): Promise<SlackClientLike> {
    if (team && this.clientForTeam) return this.clientForTeam(team);
    return this.client;
  }

  async sendPrivate(userId: string, msg: { text: string; blocks?: SlackBlock[] }, team?: string): Promise<SentMessage> {
    const client = await this.resolve(team);
    const opened = await client.conversations.open({ users: userId });
    const channel = opened.channel?.id ?? userId;
    const res = await client.chat.postMessage({ channel, text: msg.text, blocks: msg.blocks });
    return { ref: `${channel}:${res.ts ?? ""}`, channel, ts: res.ts };
  }

  async postInThread(msg: { channel: string; threadTs: string; text: string }, team?: string): Promise<SentMessage> {
    const client = await this.resolve(team);
    const res = await client.chat.postMessage({ channel: msg.channel, thread_ts: msg.threadTs, text: msg.text });
    return { ref: `${msg.channel}:${res.ts ?? ""}`, channel: msg.channel, ts: res.ts };
  }

  async update(ref: SentMessage, msg: { text: string; blocks?: SlackBlock[] }, team?: string): Promise<void> {
    const client = await this.resolve(team);
    const [channel, ts] = ref.ref.split(":");
    await client.chat.update({ channel, ts, text: msg.text, blocks: msg.blocks });
  }
}
