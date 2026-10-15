import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { GhidraClient } from "../../../src/ghidra/GhidraClient.js";
import type {
  GhidraLaunchSession,
  GhidraLauncher,
} from "../../../src/ghidra/GhidraLauncher.js";
import { ghidraProfileInstallationHost } from "../../../src/ghidra/GhidraInstallation.fixture.js";
import { GhidraProvider } from "../../../src/ghidra/GhidraProvider.js";
import type { GhidraProviderClientFactory } from "../../../src/ghidra/GhidraProviderClient.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";

const fixturePath = fileURLToPath(
  new URL("../../fixtures/fakeGhidra.mjs", import.meta.url),
);

class FixtureLauncher implements GhidraLauncher {
  readonly runtimeRoots: string[] = [];
  readonly processes: ChildProcess[] = [];

  async launch(session: GhidraLaunchSession) {
    this.runtimeRoots.push(session.runtimeRoot);
    const projectRoot = join(session.runtimeRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    const child = spawn(process.execPath, [fixturePath], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        REA_GHIDRA_FIXTURE_CONFIG: JSON.stringify({
          endpointPath: session.endpointPath,
          token: session.token,
          runId: session.runId,
          providerVersion: session.providerVersion,
          profileDigest: session.profileDigest,
          targetSha256: session.targetSha256,
          transport: session.transport,
          mode: "success",
        }),
      },
    });
    this.processes.push(child);
    return ok({
      process: child,
      ownsProcessLifetime: true as const,
      projectRoot,
      ghidraLogPath: join(session.runtimeRoot, "ghidra.log"),
      scriptLogPath: join(session.runtimeRoot, "script.log"),
    });
  }
}

const deferred = <Value = void>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const config = () => {
  const parsed = parseConfig({
    GHIDRA_INSTALL_DIR: "/fixture/ghidra",
    REA_GHIDRA_STARTUP_TIMEOUT_MS: "5000",
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

it("settles a cancelled secondary MCP waiter while shared startup continues", async () => {
  const launchEntered = deferred<void>();
  const launchGate = deferred<void>();
  const firstSettled = deferred<void>();
  const secondSettled = deferred<void>();
  const secondEntered = deferred<void>();
  const launcher = new FixtureLauncher();
  const runtimeRoots: string[] = [];
  let launchSignal: AbortSignal | undefined;
  let callCount = 0;
  const factory: GhidraProviderClientFactory = (options) => {
    const raw = new GhidraClient({
      ...options,
      launcher: {
        async launch(session, launchOptions) {
          runtimeRoots.push(session.runtimeRoot);
          launchEntered.resolve();
          launchSignal = launchOptions?.signal;
          await launchGate.promise;
          if (launchSignal?.aborted)
            return err(new AnalysisCancelledError("open_binary"));
          return launcher.launch(session);
        },
      },
    });
    return {
      start: raw.start.bind(raw),
      close: raw.close.bind(raw),
      callTool: (operation, parameters, requestOptions) => {
        const pending = raw.callTool(operation, parameters, requestOptions);
        callCount += 1;
        if (callCount === 1) return pending.finally(firstSettled.resolve);
        if (callCount === 2) {
          secondEntered.resolve();
          return pending.finally(secondSettled.resolve);
        }
        return pending;
      },
    };
  };
  const provider = new GhidraProvider(
    config(),
    silentLogger,
    {},
    ghidraProfileInstallationHost,
    factory,
  );
  const session = composeBinarySession(
    new AnalysisProviderRegistry([provider]),
  );
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const mcp = new Client({ name: "ghidra-startup-cancel", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const owner = new AbortController();
  const secondary = new AbortController();
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  try {
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    const opened = await mcp.callTool({
      name: "open_binary",
      arguments: { path: process.execPath, provider_id: "ghidra" },
    });
    expect(opened.isError).not.toBe(true);
    first = mcp
      .callTool(
        { name: "list_strings", arguments: {} },
        { signal: owner.signal },
      )
      .catch(() => undefined);
    await launchEntered.promise;
    second = mcp
      .callTool(
        { name: "list_strings", arguments: {} },
        { signal: secondary.signal },
      )
      .catch(() => undefined);
    await secondEntered.promise;
    secondary.abort();
    await secondSettled.promise;
    expect(secondary.signal.aborted).toBe(true);
    expect(launchSignal?.aborted).toBe(false);
    expect(launcher.processes).toHaveLength(0);

    owner.abort();
    launchGate.resolve();
    await firstSettled.promise;
    await first;
    await second;
    expect(launchSignal?.aborted).toBe(true);
    await expect(access(runtimeRoots[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const reopened = await mcp.callTool({
      name: "list_strings",
      arguments: {},
    });
    expect(reopened.isError).not.toBe(true);
    expect(launcher.processes).toHaveLength(1);
  } finally {
    owner.abort();
    secondary.abort();
    launchGate.resolve();
    await Promise.allSettled([first, second, mcp.close(), server.close()]);
    const closed = await session.close();
    expect(closed.ok).toBe(true);
    for (const root of runtimeRoots)
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("keeps startup for an uncancelled MCP waiter and allows warm reads", async () => {
  const launchEntered = deferred<void>();
  const launchGate = deferred<void>();
  const firstSettled = deferred<void>();
  const secondSettled = deferred<void>();
  const secondEntered = deferred<void>();
  const fixture = new FixtureLauncher();
  const runtimeRoots: string[] = [];
  let launchSignal: AbortSignal | undefined;
  let callCount = 0;
  const factory: GhidraProviderClientFactory = (options) => {
    const raw = new GhidraClient({
      ...options,
      launcher: {
        async launch(session, launchOptions) {
          runtimeRoots.push(session.runtimeRoot);
          launchEntered.resolve();
          launchSignal = launchOptions?.signal;
          await launchGate.promise;
          if (launchSignal?.aborted)
            return err(new AnalysisCancelledError("open_binary"));
          return fixture.launch(session);
        },
      },
    });
    return {
      start: raw.start.bind(raw),
      close: raw.close.bind(raw),
      callTool: (operation, parameters, requestOptions) => {
        const pending = raw.callTool(operation, parameters, requestOptions);
        callCount += 1;
        if (callCount === 1) return pending.finally(firstSettled.resolve);
        if (callCount === 2) {
          secondEntered.resolve();
          return pending.finally(secondSettled.resolve);
        }
        return pending;
      },
    };
  };
  const provider = new GhidraProvider(
    config(),
    silentLogger,
    {},
    ghidraProfileInstallationHost,
    factory,
  );
  const session = composeBinarySession(
    new AnalysisProviderRegistry([provider]),
  );
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const mcp = new Client({ name: "ghidra-startup-owner", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const owner = new AbortController();
  const secondary = new AbortController();
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  try {
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    const opened = await mcp.callTool({
      name: "open_binary",
      arguments: { path: process.execPath, provider_id: "ghidra" },
    });
    expect(opened.isError).not.toBe(true);
    first = mcp
      .callTool(
        { name: "list_strings", arguments: {} },
        { signal: owner.signal },
      )
      .catch(() => undefined);
    await launchEntered.promise;
    second = mcp
      .callTool(
        { name: "list_strings", arguments: {} },
        { signal: secondary.signal },
      )
      .catch(() => undefined);
    await secondEntered.promise;

    owner.abort();
    await firstSettled.promise;
    expect(launchSignal?.aborted).toBe(false);
    launchGate.resolve();
    await secondSettled.promise;
    await Promise.all([first, second]);
    expect(launchSignal?.aborted).toBe(false);
    expect(fixture.processes).toHaveLength(1);

    const warm = await mcp.callTool({ name: "list_strings", arguments: {} });
    expect(warm.isError).not.toBe(true);
    expect(callCount).toBe(3);
  } finally {
    owner.abort();
    secondary.abort();
    launchGate.resolve();
    await Promise.allSettled([first, second, mcp.close(), server.close()]);
    const closed = await session.close();
    expect(closed.ok).toBe(true);
    for (const root of runtimeRoots)
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
