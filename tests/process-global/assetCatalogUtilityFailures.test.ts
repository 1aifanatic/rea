import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stdout: undefined as string | undefined,
}));

// Replace only assetutil: a stalled child under the production command owner,
// or a successful run with the selected stdout.
vi.mock("../../src/process/ExecFileOutput.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/process/ExecFileOutput.js")
    >();
  return {
    ...actual,
    execFileOutput: vi.fn(
      async (
        _command: string,
        _arguments: readonly string[],
        options: Parameters<typeof actual.execFileOutput>[2],
      ) =>
        state.stdout === undefined
          ? actual.execFileOutput(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)"],
              { ...options, timeout: 50 },
            )
          : {
              stdout: state.stdout,
              stderr: "",
              stdoutBytes: 0,
              stderrBytes: 0,
            },
    ),
  };
});

import { analyzeAppleAssetCatalogs } from "../../src/artifacts/apple/AppleAssetCatalogAnalysis.js";
import { translateArtifactFailure } from "../../src/artifacts/ArtifactOperationFailure.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const canSimulateDarwin =
  process.platform === "darwin" || platformDescriptor?.configurable === true;

/** Run the macOS-only catalog path on non-macOS CI without changing production behavior. */
const withDarwinPlatform = async <T>(run: () => Promise<T>): Promise<T> => {
  if (process.platform === "darwin") return run();
  if (platformDescriptor?.configurable !== true)
    throw new Error("This host cannot simulate the macOS catalog gate");
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "darwin",
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
};

/** Project one catalog inspection as the artifact provider reports it. */
const inspect = async (stdout: string | undefined) => {
  const bundle = await createTestTempDirectory("rea-asset-catalog-utility-");
  await mkdir(join(bundle, "Contents", "Resources"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Resources", "Assets.car"),
    "inert catalog fixture",
  );
  state.stdout = stdout;
  try {
    return await withDarwinPlatform(() =>
      analyzeAppleAssetCatalogs({
        bundlePath: bundle,
        targetSha256: "0".repeat(64),
        environment: {},
        analyzeInterfaceBuilder: (async () => ({
          graph: { nodes: [], truncated: false },
        })) as never,
      }),
    ).then(
      (value) => ({ ok: true, value }) as const,
      (cause: unknown) =>
        ({
          ok: false,
          error: projectAnalysisError(
            translateArtifactFailure("inspect_asset_catalog", cause),
          ),
        }) as const,
    );
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
};

it.skipIf(!canSimulateDarwin)(
  "reports an assetutil deadline as a provider timeout, not artifact I/O",
  async () => {
    const result = await inspect(undefined);
    if (result.ok) throw new Error("Expected an assetutil deadline");
    expect(result.error).toMatchObject({
      code: "provider_timeout",
      details: { timeout_ms: 60_000 },
      recovery: { kind: "inspect_timeout_state" },
      remediation: {
        action: expect.stringContaining(
          "inspect_asset_catalog has no setting for this 60000 ms deadline",
        ),
      },
    });
    expect(JSON.stringify(result.error)).not.toContain("file access");
  },
);

it.skipIf(!canSimulateDarwin).each([
  ["not json", "assetutil returned invalid JSON ("],
  ["{}", "assetutil output must be a JSON array"],
  ["[null]", "assetutil record 0 is not a JSON object"],
])(
  "reports unparseable assetutil stdout %j as unreadable utility output",
  async (stdout, reason) => {
    const result = await inspect(stdout);
    if (result.ok) throw new Error("Expected unparseable assetutil output");
    expect(result.error).toMatchObject({
      code: "unreadable_output",
      details: {
        operation: "inspect_asset_catalog",
        reason: expect.stringContaining(reason),
      },
      remediation: {
        action: expect.stringContaining("catalog bytes were unchanged"),
      },
    });
    expect(result.error.details).toMatchObject({
      reason: expect.stringContaining("Contents/Resources/Assets.car"),
    });
    expect(JSON.stringify(result.error)).not.toContain("fresh copy");
  },
);

it.skipIf(!canSimulateDarwin)(
  "accepts an empty assetutil record array",
  async () => {
    const result = await inspect("[]");
    expect(result.ok).toBe(true);
  },
);
