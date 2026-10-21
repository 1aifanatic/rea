import { describe, expect, it } from "vitest";

import { CdpCaptureEvents } from "../../../src/browser/CdpCaptureEvents.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";

const ORIGIN = "https://app.example";

const captureEvents = (includeConsoleText: boolean): CdpCaptureEvents =>
  new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: [ORIGIN],
      target_id: "page",
      observation_ms: 0,
      include_console_text: includeConsoleText,
    }),
    new Set([ORIGIN]),
  );

describe("CDP console text capture", () => {
  it("retains null primitive argument alongside undefined and boolean while keeping objects unexpanded", () => {
    const events = captureEvents(true);
    events.beginAuthorizedFrame("frame-1");

    events.ingest({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        timestamp: 100,
        args: [
          { type: "object", subtype: "null", value: null },
          { type: "undefined" },
          { type: "boolean", value: false },
          {
            type: "object",
            objectId: "remote-obj-1",
            description: "Object",
          },
        ],
        stackTrace: {
          callFrames: [
            {
              url: `${ORIGIN}/app.js`,
              lineNumber: 10,
              columnNumber: 5,
            },
          ],
        },
      },
    });

    expect(events.console).toHaveLength(1);
    const event = events.console[0]!;
    expect(event.argument_types).toEqual([
      "object",
      "undefined",
      "boolean",
      "object",
    ]);
    expect(event.text_capture).toEqual({
      status: "included",
      values: [
        { argument_index: 0, type: "null", text: "null" },
        { argument_index: 1, type: "undefined", text: "undefined" },
        { argument_index: 2, type: "boolean", text: "false" },
      ],
      retained_bytes:
        Buffer.byteLength("null") +
        Buffer.byteLength("undefined") +
        Buffer.byteLength("false"),
    });
  });

  it("omits text capture values when include_console_text is unselected", () => {
    const events = captureEvents(false);
    events.beginAuthorizedFrame("frame-1");

    events.ingest({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        timestamp: 100,
        args: [
          { type: "object", subtype: "null", value: null },
          { type: "undefined" },
          { type: "boolean", value: false },
        ],
        stackTrace: {
          callFrames: [
            {
              url: `${ORIGIN}/app.js`,
              lineNumber: 10,
              columnNumber: 5,
            },
          ],
        },
      },
    });

    expect(events.console).toHaveLength(1);
    const event = events.console[0]!;
    expect(event.text_capture).toEqual({
      status: "not_approved",
      values: [],
      retained_bytes: 0,
    });
  });
});
