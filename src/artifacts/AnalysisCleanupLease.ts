import type { AnalysisError } from "../domain/analysisErrorBase.js";

/** Link one resource's confirmed release to its originating analysis error. */
export class AnalysisCleanupLease {
  #released = false;
  #error: AnalysisError | undefined;

  constructor(private readonly cleanup: () => Promise<void>) {}

  async release(): Promise<void> {
    if (this.#released) return;
    await this.cleanup();
    this.#released = true;
    this.#error?.resolveCleanup();
  }

  /** Binding can follow a concurrent retry that already confirmed release. */
  bindCleanupError(error: AnalysisError): void {
    this.#error = error;
    if (this.#released) error.resolveCleanup();
  }
}
