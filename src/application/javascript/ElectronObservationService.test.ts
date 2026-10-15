import { describe, expect, it } from "vitest";

import type { ElectronObservationPort } from "./ElectronObservationPort.js";
import { listElectronTargets } from "./ElectronObservationService.js";
import { inspectElectronPage } from "./ElectronObservationService.js";
import { CDP_ELECTRON_PROVIDER_IDENTITY } from "../../browser/providerIdentities.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { classifyBrowserCompleteness } from "../../domain/browserCompleteness.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
  type ElectronPageInspection,
} from "../../domain/javascript/electronObservation.js";
import { err } from "../../domain/result.js";

describe("Electron observation completion", () => {
  it("retains completed target facts when cancellation arrives before Evidence publication", async () => {
    const controller = new AbortController();
    const provider: ElectronObservationPort = {
      identity: () => CDP_ELECTRON_PROVIDER_IDENTITY,
      listTargets: async () => {
        controller.abort();
        return {
          ok: true,
          value: {
            browser: {
              product: "Chromium",
              protocol_version: "1.3",
              revision: "123",
              user_agent: "fixture",
              js_version: "V8",
            },
            targets: [],
            excluded: { unsupported_url: 0, non_page: 0 },
            limitations: [],
          },
        };
      },
      inspectPage: async () => {
        throw new Error("unexpected inspection");
      },
    };

    const result = await listElectronTargets(
      provider,
      listElectronTargetsInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
      }),
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        partialObservation: {
          operation: "list_electron_targets",
          normalized_result: {
            targets: [],
            excluded: { unsupported_url: 0, non_page: 0 },
          },
        },
      },
    });
  });

  it("converts a provider's completed late-cancel observation into retained Evidence", async () => {
    const inspection = {
      browser: {
        product: "Chromium",
        protocol_version: "1.3",
        revision: "123",
        user_agent: "fixture",
        js_version: "V8",
      },
      target: {
        target_id: "target-1",
        type: "page",
        title: "fixture",
        file_path: "/tmp/index.html",
        attached: true,
      },
      capture_window: {
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: "2026-01-01T00:00:00.001Z",
        observation_ms: 1,
      },
      completeness: classifyBrowserCompleteness({
        policyFilteredSections: new Set(),
        attachLimitedSections: new Set(),
        truncatedSections: new Set(),
        unavailableSections: new Set(),
        excluded: [],
        droppedEvents: {
          scripts: 0,
          network_requests: 0,
          console_events: 0,
          websocket_connections: 0,
          websocket_frames: 0,
          webmcp_tools: 0,
          timeline_events: 0,
        },
      }),
      frames: [],
      dom: { total_nodes: 0, nodes: [] },
      scripts: { total: 0, items: [] },
      resources: [],
      workers: [],
      limitations: [],
    } satisfies ElectronPageInspection;
    const provider: ElectronObservationPort = {
      identity: () => CDP_ELECTRON_PROVIDER_IDENTITY,
      listTargets: async () => {
        throw new Error("unexpected listing");
      },
      inspectPage: async () =>
        err(
          new AnalysisCancelledError("inspect_electron_page", {
            partialObservation: {
              kind: "electron-page-observation",
              inspection,
              cleanup: "transport-closed",
            },
          }),
        ),
    };

    const result = await inspectElectronPage(
      provider,
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target-1",
        observation_ms: 0,
        include_script_sources: false,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error).toMatchObject({ _tag: "AnalysisCancelledError" });
    expect(result.error.partialObservation).toMatchObject({
      operation: "inspect_electron_page",
      normalized_result: { target: { target_id: "target-1" } },
      limitations: expect.arrayContaining([
        "Browser host platform and architecture were not observed.",
        "REA closed its CDP transport; this does not imply target shutdown.",
      ]),
    });
  });
});
