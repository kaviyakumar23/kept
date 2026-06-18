export class GuardViolation extends Error {
  constructor(
    message: string,
    readonly code:
      | "ILLEGAL_TRANSITION"
      | "APPROVAL_REQUIRED"
      | "EVIDENCE_REQUIRED"
      | "INSUFFICIENT_EVIDENCE"
      | "UNKNOWN_OBLIGATION"
      | "RAW_CONTENT_PERSISTED",
  ) {
    super(message);
    this.name = "GuardViolation";
  }
}
