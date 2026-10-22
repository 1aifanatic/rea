import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { evmInterfaceFailure } from "./EvmoleFailures.js";
import { EVM_INTERFACE_LIMITS } from "./EvmoleRelease.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_EVM_TIMEOUT_MS,
  MAX_EVM_TIMEOUT_MS,
} from "../domain/evm/evmInterface.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";

const snapshot: ProviderProcessSnapshot = {
  stdout: { text: "selected output", bytes: 15, observedBytes: 15 },
  stderr: { text: "warning", bytes: 7, observedBytes: 7 },
  exitCode: 0,
  signal: null,
};

it.each([
  undefined,
  null,
  "caller stopped",
  { requested: "stop" },
  new AnalysisCancelledError("foreign", {
    cleanup: { reason: "foreign owner", resources: ["foreign-resource"] },
  }),
])(
  "retains the exact command cancellation reason as opaque data: %j",
  (reason) => {
    const source = new OwnedCommandFailure(
      "cancelled",
      "cancelled",
      snapshot,
      null,
      {
        cancellation: { reason },
      },
    );
    const result = evmInterfaceFailure(source, "worker", "/selected.hex");
    expect(result).toBeInstanceOf(AnalysisCancelledError);
    expect(result.cause).toBe(reason);
    expect(result.capturedOutput).toEqual({
      stdout: "selected output",
      stderr: "warning",
      truncated: false,
    });
    expect(result.cleanupIncomplete).toBe(false);
  },
);

it("names timeout_ms, the omitted default, and the caps it does not raise", () => {
  const source = new OwnedCommandFailure(
    "timeout",
    "Command deadline elapsed.",
    snapshot,
    null,
  );
  const projected = projectAnalysisError(
    evmInterfaceFailure(
      source,
      "worker",
      "/selected.hex",
      undefined,
      undefined,
      undefined,
      45_000,
    ),
  );
  expect(projected).toMatchObject({
    code: "provider_timeout",
    details: { timeout_ms: 45_000 },
  });
  expect(projected.message).toContain("timeout_ms");
  expect(projected.message).toContain(String(DEFAULT_EVM_TIMEOUT_MS));
  expect(projected.remediation.action).toContain("--timeout-ms");
  expect(projected.remediation.action).toContain(String(MAX_EVM_TIMEOUT_MS));
  expect(projected.remediation.action).toContain("does not raise");
  expect(projected.remediation.action).toContain("no server restart");
});

it("says a CPU signal has no runtime override and timeout_ms does not raise it", () => {
  const source = new OwnedCommandFailure(
    "process",
    "signaled",
    {
      ...snapshot,
      exitCode: null,
      signal: "SIGXCPU",
    },
    null,
  );
  const projected = projectAnalysisError(
    evmInterfaceFailure(source, "worker", "/selected.hex", {
      addressSpaceBytes: 1024,
      cpuSeconds: 30,
      fileSizeBytes: 1024,
    }),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: { resource: "cpu" },
  });
  expect(projected.remediation.action).toContain("no runtime override");
  expect(projected.remediation.action).toContain(
    "timeout_ms does not raise it",
  );
});

it.each([
  { failure: "process" as const, cleanup: null, tag: "ProviderAdapterError" },
  { failure: "timeout" as const, cleanup: null, tag: "AnalysisTimeoutError" },
  {
    failure: "cancelled" as const,
    cleanup: "close refused",
    tag: "ProviderAdapterError",
  },
])("keeps $tag ahead of recorded cancellation", ({ failure, cleanup, tag }) => {
  const source = new OwnedCommandFailure(
    failure,
    "physical outcome",
    snapshot,
    cleanup,
    {
      cancellation: { reason: "later interruption" },
    },
    ["exact-owner"],
  );
  const result = evmInterfaceFailure(source, "worker", "/selected.hex");
  expect(result._tag).toBe(tag);
  if (cleanup !== null) {
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.cleanupResources).toEqual(["exact-owner"]);
  }
});

it("reports the fixed carrier input allowance as a file-size resource constraint", async () => {
  const root = await createTestTempDirectory("rea-evm-input-allowance-");
  const refusal = async (path: string) => {
    try {
      await readStableArtifact(path, EVM_INTERFACE_LIMITS.inputBytes);
    } catch (cause: unknown) {
      return projectAnalysisError(
        evmInterfaceFailure(cause, "artifact-read", path),
      );
    }
    throw new Error("Expected the carrier read to be refused");
  };
  const oversized = join(root, "selected.bin");
  await writeFile(oversized, "");
  await truncate(oversized, EVM_INTERFACE_LIMITS.inputBytes + 1);
  const projected = await refusal(oversized);
  expect(projected).toMatchObject({
    code: "resource_constraint",
    category: "resource_constraint",
    retryable: false,
    details: {
      resource: "file-size",
      reported_limits: { maximum_input_bytes: 4_194_304 },
    },
    remediation: {
      action: expect.stringContaining("4194304-byte input allowance"),
    },
  });
  expect(projected.recovery?.kind).not.toBe("inspect_input_contract");
  expect(projected.details).not.toHaveProperty("issues");
  // A directory remains an input correction, not a resource constraint.
  expect(await refusal(root)).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["path"], reason: "invalid_format" }] },
  });
});
