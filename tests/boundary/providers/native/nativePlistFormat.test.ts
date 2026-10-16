import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  NativeFixtureRunner,
  nativeMachoTargetForFile,
} from "../../../fixtures/nativeCommands.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("inspect_plist format classification", () => {
  it("classifies xml, binary, and unknown (OpenStep) formats without reporting text as xml", async () => {
    directory = await createTestTempDirectory("rea-plist-format-");
    const app = join(directory, "Fixture.app");
    const executable = join(app, "Contents/MacOS/Fixture");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await writeFile(executable, "fixture");
    await writeFile(join(app, "Contents/Info.plist"), "fixture");
    const target = await nativeMachoTargetForFile(executable, app);

    const xmlClient = new NativeMacOSProvider(
      {},
      new NativeFixtureRunner({
        "file:-b": "XML 1.0 document text, ASCII text\n",
      }),
      "darwin",
    ).createClient(target);
    const xmlResult = await xmlClient.execute("inspect_plist", {});
    expect(xmlResult.ok && xmlResult.value.result).toMatchObject({
      format: "xml",
    });

    const openstepClient = new NativeMacOSProvider(
      {},
      new NativeFixtureRunner({ "file:-b": "ASCII text\n" }),
      "darwin",
    ).createClient(target);
    const openstepResult = await openstepClient.execute("inspect_plist", {});
    expect(openstepResult.ok && openstepResult.value.result).toMatchObject({
      format: "unknown",
    });

    const binaryClient = new NativeMacOSProvider(
      {},
      new NativeFixtureRunner({ "file:-b": "Apple binary property list\n" }),
      "darwin",
    ).createClient(target);
    const binaryResult = await binaryClient.execute("inspect_plist", {});
    expect(binaryResult.ok && binaryResult.value.result).toMatchObject({
      format: "binary",
    });
  });
});
