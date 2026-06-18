import * as dotenv from "dotenv";

dotenv.config();

export interface KeptConfig {
  llmModel: string;
  anthropicApiKey: string | undefined;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  slack: {
    botToken: string | undefined;
    signingSecret: string | undefined;
    appToken: string | undefined;
  };
  riskWindowMs: number;
}

export function loadConfig(): KeptConfig {
  return {
    llmModel: process.env.KEPT_LLM_MODEL ?? "claude-opus-4-8",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      appToken: process.env.SLACK_APP_TOKEN,
    },
    riskWindowMs: Number(process.env.KEPT_RISK_WINDOW_MS ?? 24 * 60 * 60 * 1000),
  };
}
