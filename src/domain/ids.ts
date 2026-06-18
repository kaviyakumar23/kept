import { randomUUID } from "node:crypto";

export type ObligationId = string;
export type EventId = string;
/** A Slack user id (e.g. "U07ACME"). Account owners / internal owners. */
export type UserId = string;

export const newObligationId = (): ObligationId => `obl_${randomUUID()}`;
export const newEventId = (): EventId => `evt_${randomUUID()}`;
