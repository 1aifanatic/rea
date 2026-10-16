import { describe, expect, it } from "vitest";

import { createBrowserEvidence } from "../../../src/application/BrowserEvidence.js";
import {
  analyzeWebBundleInputSchema,
  type WebBundleAnalysis,
} from "../../../src/domain/webBundleAnalysis.js";

const PROVIDER = {
  id: "rea-cdp-browser",
  name: "rea-cdp-browser",
  version: "1.0.0",
};

describe("web bundle Evidence creation", () => {
  const dummyAnalysis: WebBundleAnalysis = {
    capture: {
      target_url: "https://example.com/app/index.html",
      scripts_observed: 1,
      scripts_analyzed: 1,
      source_artifacts: [],
    },
    observations: {
      chunks: { nodes: [], edges: [] },
      routes: [],
      endpoints: [],
      webmcp_declarations: [],
      source_maps: {
        status: "not_requested",
        requested: 0,
        processed: 0,
        items: [],
      },
    },
    inferences: [],
    unknowns: [],
    completeness: {
      status: "complete",
      parsed_scripts: 1,
      parse_failures: 0,
      visited_ast_nodes: 10,
    },
    limitations: [],
  };

  it("records the effective default origin scope from the analyzed bundle capture", () => {
    const input = analyzeWebBundleInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target-1",
    });

    const evidence = createBrowserEvidence(
      "analyze_web_bundle",
      input,
      dummyAnalysis,
      PROVIDER,
    );

    expect(evidence.parameters).toMatchObject({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target-1",
      allowed_origins: ["https://example.com"],
    });
  });

  it("preserves explicit allowed_origins when provided", () => {
    const input = analyzeWebBundleInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target-1",
      allowed_origins: ["https://explicit.example.com"],
    });

    const evidence = createBrowserEvidence(
      "analyze_web_bundle",
      input,
      dummyAnalysis,
      PROVIDER,
    );

    expect(evidence.parameters).toMatchObject({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target-1",
      allowed_origins: ["https://explicit.example.com"],
    });
  });
});
