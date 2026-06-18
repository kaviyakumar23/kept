import { describe, it, expect } from "vitest";
import { slackRequestKey, linearStatusKey, notifyKey, hasIdempotencyKey } from "../src/engine/idempotency.js";
import { evt } from "./helpers.js";

describe("idempotency keys (C6)", () => {
  it("builds deterministic keys", () => {
    expect(slackRequestKey("T1", "C1", "1718.0001")).toBe("slack:T1:C1:1718.0001:request_detected");
    expect(linearStatusKey("PROJ-118", "2026-06-18T10:00:00Z", "Done")).toBe("linear:PROJ-118:2026-06-18T10:00:00Z:Done");
    expect(notifyKey("obl_1", "CUSTOMER_NOTIFIED", 7)).toBe("notify:obl_1:CUSTOMER_NOTIFIED:7");
  });

  it("the same inputs always produce the same key", () => {
    expect(slackRequestKey("T", "C", "ts")).toBe(slackRequestKey("T", "C", "ts"));
  });

  it("detects an already-applied key in a log", () => {
    const e = evt({ type: "WORK_STARTED" }, { idempotency_key: "kx" });
    expect(hasIdempotencyKey([e], "kx")).toBe(true);
    expect(hasIdempotencyKey([e], "ky")).toBe(false);
  });
});
