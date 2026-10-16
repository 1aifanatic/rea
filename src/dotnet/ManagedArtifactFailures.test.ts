import { describe, expect, it } from "vitest";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  buildNativePeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { readManagedPeLayout } from "./ManagedPeReader.js";

describe("managed artifact failure classification", () => {
  it("distinguishes native, malformed, and unsupported metadata", () => {
    const nativeBytes = buildNativePeFixture();
    const native = inspectManagedArtifactBytes(
      nativeBytes,
      managedPeFixtureTarget(nativeBytes),
    );
    expect(native).toMatchObject({
      classification: { status: "not-managed" },
      metadata: { status: "absent" },
      coverage: { state: "unavailable" },
    });

    const malformedBytes = buildManagedPeFixture({
      corruptMetadataSignature: true,
    });
    const malformed = inspectManagedArtifactBytes(
      malformedBytes,
      managedPeFixtureTarget(malformedBytes),
    );
    expect(malformed.classification.status).toBe("malformed");
    expect(malformed.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-metadata-root" }),
    ]);

    const unsupportedTableBytes = buildManagedPeFixture({
      metadataValidMaskExtra: 1n << 50n,
    });
    const unsupportedTable = inspectManagedArtifactBytes(
      unsupportedTableBytes,
      managedPeFixtureTarget(unsupportedTableBytes),
    );
    expect(unsupportedTable.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-tables" }),
    ]);
  });

  it("rejects a ReadyToRun OS-override machine without a CLI directory", () => {
    const bytes = buildNativePeFixture();
    bytes.writeUInt16LE(0x014c ^ 0x7b79, bytes.readUInt32LE(0x3c) + 4);
    expect(() =>
      inspectManagedArtifactBytes(bytes, managedPeFixtureTarget(bytes)),
    ).toThrow("Unsupported PE machine 0x7a35");
  });

  it("keeps malformed reference and attribute issues across inventory callers", () => {
    const bytes = buildManagedPeFixture({
      references: [
        "System.Runtime",
        "System.Runtime",
        "UnityEngine.CoreModule",
      ],
      malformedAssemblyReferenceRows: [3],
      malformedCustomAttributeRows: [1],
    });
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target);
    const boundaries = inspectManagedNativeBoundariesBytes(bytes, target);
    const issueCodes = ["invalid-heap-index", "invalid-row"];

    expect(artifact.references.map(({ name }) => name)).toEqual([
      "System.Runtime",
      "System.Runtime",
    ]);
    expect(artifact.attributes).toEqual([]);
    expect(artifact.coverage.issues.map(({ code }) => code)).toEqual(
      issueCodes,
    );
    expect(members.coverage.issues.map(({ code }) => code)).toEqual(issueCodes);
    expect(boundaries.coverage).toMatchObject({
      state: "partial",
      issues: [
        expect.objectContaining({ code: "invalid-heap-index" }),
        expect.objectContaining({ code: "invalid-row" }),
      ],
    });
  });

  it("reports artifact file coordinates for malformed metadata stream names", () => {
    const valid = buildManagedPeFixture();
    const pe = readManagedPeLayout(valid);
    if (!pe.cli) throw new Error("Expected CLI directory");
    const root = pe.rvaToOffset(
      pe.cli.metadata.rva,
      pe.cli.metadata.size,
      "cli.metadata",
    );
    const relative =
      Math.ceil((16 + valid.readUInt32LE(root + 12)) / 4) * 4 + 12;
    const expected = root + relative;

    for (const mode of ["non-printable", "unterminated"] as const) {
      const bytes = Buffer.from(valid);
      if (mode === "non-printable") bytes[expected] = 1;
      else bytes.fill(0x41, expected, expected + 32);
      const result = inspectManagedArtifactBytes(
        bytes,
        managedPeFixtureTarget(bytes),
      );
      expect(result.coverage.state).toBe("partial");
      expect(result.classification.evidence[0]?.file_offset).toBe(expected);
      const issue = result.coverage.issues[0];
      expect(issue).toMatchObject({
        code: "invalid-stream",
        scope: "metadata.stream-name",
        offset: expected,
      });
      if (mode === "non-printable") {
        expect(issue?.detail).toBe(
          "Metadata stream name is not printable ASCII",
        );
      } else {
        expect(issue?.detail).toBe(
          "Metadata stream name is missing a bounded terminator",
        );
      }
    }
  });
});
