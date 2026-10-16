import { expect, it } from "vitest";

import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { AnalysisCleanupLease } from "./AnalysisCleanupLease.js";

it.each(["before release", "after release"])(
  "resolves its originating error bound %s without erasing the cause",
  async (binding) => {
    const cause = new Error("first close failed");
    const error = new ProviderCleanupError(
      "fixture",
      ["owned resource"],
      { reason: cause.message },
      { cause },
    );
    let releases = 0;
    const lease = new AnalysisCleanupLease(async () => {
      releases += 1;
    });
    if (binding === "before release") lease.bindCleanupError(error);
    await lease.release();
    if (binding === "after release") lease.bindCleanupError(error);
    expect(error.cleanupIncomplete).toBe(false);
    expect(error.cause).toBe(cause);
    await lease.release();
    expect(releases).toBe(1);
  },
);

it("retains uncertainty across a failed retry until the same lease releases", async () => {
  const cause = new Error("close still denied");
  const error = new ProviderCleanupError("fixture", ["owned resource"], {});
  let denied = true;
  const lease = new AnalysisCleanupLease(async () => {
    if (denied) throw cause;
  });
  lease.bindCleanupError(error);
  await expect(lease.release()).rejects.toBe(cause);
  expect(error.cleanupIncomplete).toBe(true);
  denied = false;
  await lease.release();
  expect(error.cleanupIncomplete).toBe(false);
});
