import type { CommandKind } from "../domain/commands.js";

/**
 * D2 — Human-in-the-loop action tiers.
 *
 *   • AUTOMATIC          — Kept may do this without asking (detect, retrieve, suggest).
 *   • HUMAN_CONFIRMATION — requires a person to approve (the two gates + ticket/notify/close).
 *   • NEVER_AUTONOMOUS   — Kept must never do this (promise scope, offer comp, admit liability…).
 *
 * The engine's transition guards independently enforce approved_by for the gate
 * transitions; this table is the policy surface adapters use to decide what needs
 * a confirm card, and what the eval asserts against (unauthorized-action rate).
 */
export type ActionTier = "AUTOMATIC" | "HUMAN_CONFIRMATION" | "NEVER_AUTONOMOUS";

export const ACTION_TIERS: Record<CommandKind, ActionTier> = {
  DETECT_REQUEST: "AUTOMATIC",
  FLAG_CLARIFICATION: "AUTOMATIC",
  CLEAR_CLARIFICATION: "AUTOMATIC",
  START_WORK: "AUTOMATIC",
  RECORD_SCOPE_CHANGE: "AUTOMATIC",
  RECORD_FULFILLMENT_SIGNAL: "AUTOMATIC",
  REJECT_FULFILLMENT: "AUTOMATIC",
  RECORD_CUSTOMER_CONFIRMATION: "AUTOMATIC",
  REOPEN: "AUTOMATIC",

  CONFIRM_COMMITMENT: "HUMAN_CONFIRMATION", // Gate 1
  LINK_WORK_ITEM: "HUMAN_CONFIRMATION",
  CHANGE_DUE_DATE: "HUMAN_CONFIRMATION",
  VERIFY_FULFILLMENT: "HUMAN_CONFIRMATION", // Gate 2
  NOTIFY_CUSTOMER: "HUMAN_CONFIRMATION",
  DISMISS: "HUMAN_CONFIRMATION",
  CANCEL: "HUMAN_CONFIRMATION",
};

/** Things Kept must never do autonomously — enforced by absence from the command set + the audience layer. */
export const NEVER_AUTONOMOUS: readonly string[] = [
  "promise new scope",
  "offer compensation",
  "admit liability",
  "reveal confidential reasons",
  "publicly escalate a teammate",
];

export const requiresHumanApproval = (kind: CommandKind): boolean =>
  ACTION_TIERS[kind] === "HUMAN_CONFIRMATION";
