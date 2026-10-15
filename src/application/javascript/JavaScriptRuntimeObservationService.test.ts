import { expect, it } from "vitest";

import { BrowserObservationError } from "../../domain/browserObservationError.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { err, ok } from "../../domain/result.js";
import type { JavaScriptRuntimeObservationPort } from "./JavaScriptRuntimeObservationPort.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "./JavaScriptRuntimeObservationService.js";

it("preserves failed Inspector cleanup when cancellation occurs during observation", async () => {
  const controller = new AbortController();
  const failure = new BrowserObservationError(
    "observe_javascript_runtime",
    "cleanup_failed",
    {
      cause: new AnalysisCancelledError("observe_javascript_runtime"),
    },
  );
  const provider: JavaScriptRuntimeObservationPort = {
    identity: () => ({
      id: "test-inspector",
      name: "Test Inspector",
      version: "1",
    }),
    listTargets: async () => err(failure),
    observe: async () => {
      controller.abort();
      return err(failure);
    },
  };
  const result = await observeJavaScriptRuntime(
    provider,
    {
      inspector_endpoint: "http://127.0.0.1:9229",
      target_id: "target",
      observation_ms: 0,
    },
    { signal: controller.signal },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failed cleanup");
  expect(result.error).toBe(failure);
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual(["browser_transport"]);
  expect(result.error.userCategory).toBe("cancelled");
});

it("retains target Evidence when cancellation arrives during provider cleanup", async () => {
  const controller = new AbortController();
  const provider: JavaScriptRuntimeObservationPort = {
    identity: () => ({
      id: "test-inspector",
      name: "Test Inspector",
      version: "1",
    }),
    listTargets: async () => {
      controller.abort();
      return ok({
        runtime: {
          product: "node.js/v24",
          protocol_version: "1.3",
          v8_version: "13",
        },
        targets: [],
        excluded: { unsupported_location: 0, unconnectable: 0 },
        limitations: [],
      });
    },
    observe: async () =>
      err(new AnalysisCancelledError("observe_javascript_runtime")),
  };
  const result = await listJavaScriptRuntimeTargets(
    provider,
    { inspector_endpoint: "http://127.0.0.1:9229" },
    { signal: controller.signal },
  );

  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      operation: "list_javascript_runtime_targets",
      partialObservation: {
        normalized_result: {
          runtime: { product: "node.js/v24" },
          targets: [],
        },
      },
    },
  });
});

it("preserves runtime Evidence serialization failures when cancellation is also reported", async () => {
  const controller = new AbortController();
  const value = {
    runtime: {
      product: "node.js/v24",
      protocol_version: "1.3",
      v8_version: "13",
    },
    targets: [],
    excluded: { unsupported_location: 0, unconnectable: 0 },
    limitations: [] as string[],
  };
  Reflect.set(value, "limitations", [undefined]);
  const provider: JavaScriptRuntimeObservationPort = {
    identity: () => ({
      id: "test-inspector",
      name: "Test Inspector",
      version: "1",
    }),
    listTargets: async () => {
      controller.abort();
      return ok(value);
    },
    observe: async () =>
      err(new AnalysisCancelledError("observe_javascript_runtime")),
  };

  await expect(
    listJavaScriptRuntimeTargets(
      provider,
      { inspector_endpoint: "http://127.0.0.1:9229" },
      { signal: controller.signal },
    ),
  ).rejects.toThrow();
});
