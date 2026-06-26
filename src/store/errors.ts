/**
 * Raised when an append's `expectedVersion` does not match the obligation's current
 * event count — i.e. another writer advanced the obligation between our read and our
 * write. The orchestrating layer (ObligationService.dispatch) catches this and retries
 * (re-read → re-decide → re-append), so two *different* commands racing on one
 * obligation are serialized by causality rather than silently both applying.
 */
export class ConcurrencyError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
    readonly obligationId?: string,
  ) {
    super(`concurrency conflict: expected version ${expectedVersion}, found ${actualVersion}${obligationId ? ` for ${obligationId}` : ""}`);
    this.name = "ConcurrencyError";
  }
}
