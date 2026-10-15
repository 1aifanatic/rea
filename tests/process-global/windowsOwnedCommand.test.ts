import { EventEmitter, once } from "node:events";

import { expect, it, vi } from "vitest";

import {
  createWindowsOwnedCommand,
  loadWindowsOwnedProcessClass,
  superviseWindowsOwnedProcess,
} from "../../scripts/lib/windows-owned-command.mjs";

it("imports the source Windows owner without dist using a fake native authority", async () => {
  const calls: string[] = [];
  const WindowsOwnedProcess = await loadWindowsOwnedProcessClass();
  const child = new WindowsOwnedProcess(
    "ignored.exe",
    [],
    undefined,
    {},
    false,
    {
      authority: {
        inspection: {
          abiVersion: 1,
          nodeApiVersion: 8,
          architecture: "x64",
          filesystem: {
            requestedPath: "C:\\probe",
            finalPath: "C:\\probe",
            filesystem: "NTFS",
            volumeSerial: "0".repeat(16),
            fileId: "0".repeat(32),
            size: 0,
            directory: true,
          },
          privateDacl: true,
          privateBridgeDescriptorAccess: true,
          atomicJobAssignment: true,
          killOnOwnerClose: true,
        },
        call(operation: string) {
          calls.push(operation);
          if (operation === "process_spawn")
            return {
              pid: 42,
              handle: {},
              jobAssigned: true,
              killOnOwnerClose: true,
            };
          if (operation === "process_poll")
            return {
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              stdoutEnded: true,
              stderrEnded: true,
              exitCode: 0,
              activeProcesses: 0,
            };
          if (operation === "process_close") return null;
          throw new Error(`Unmodeled fake native operation ${operation}`);
        },
      },
    },
  );

  await expect(once(child, "close")).resolves.toEqual([0, null]);
  expect(calls).toEqual(["process_spawn", "process_poll", "process_close"]);
});

it("supervises protocol stdin errors until the owned job and stream close", async () => {
  const calls: string[] = [];
  let activeProcesses = 1;
  const writeFailure = new Error("controlled native stdin failure");
  const WindowsOwnedProcess = await loadWindowsOwnedProcessClass();
  const child = createWindowsOwnedCommand({
    WindowsOwnedProcess,
    command: "ignored.exe",
    arguments: [],
    cwd: undefined,
    environment: {},
    authority: {
      inspection: {
        abiVersion: 1,
        nodeApiVersion: 8,
        architecture: "x64",
        filesystem: {
          requestedPath: "C:\\probe",
          finalPath: "C:\\probe",
          filesystem: "NTFS",
          volumeSerial: "0".repeat(16),
          fileId: "0".repeat(32),
          size: 0,
          directory: true,
        },
        privateDacl: true,
        privateBridgeDescriptorAccess: true,
        atomicJobAssignment: true,
        killOnOwnerClose: true,
        protocolStdin: true,
      },
      call(operation: string) {
        calls.push(operation);
        if (operation === "process_spawn")
          return {
            pid: 42,
            handle: {},
            jobAssigned: true,
            killOnOwnerClose: true,
          };
        if (operation === "process_stdin_write") throw writeFailure;
        if (operation === "process_stdin_close") return null;
        if (operation === "process_terminate") {
          activeProcesses = 0;
          return true;
        }
        if (operation === "process_poll")
          return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            stdoutEnded: true,
            stderrEnded: true,
            exitCode: 0,
            activeProcesses,
          };
        if (operation === "process_close") return null;
        throw new Error(`Unmodeled fake native operation ${operation}`);
      },
    },
  });
  const lifecycle = superviseWindowsOwnedProcess(child, {
    retryIntervalMs: 10,
  });
  if (child.stdin === null) throw new Error("fixture protocol stdin missing");
  const stdin = child.stdin;
  const write = new Promise<Error | null>((resolve) => {
    stdin.write(Buffer.from("x"), (cause?: Error | null) =>
      resolve(cause ?? null),
    );
  });

  await expect(write).resolves.toBe(writeFailure);
  await expect(lifecycle.finished).rejects.toBe(writeFailure);
  expect(calls).toContain("process_terminate");
  expect(calls).toContain("process_close");
});

it("retries thrown and false cleanup results, then preserves the first error", async () => {
  vi.useFakeTimers();
  try {
    class ControlledOwnedProcess extends EventEmitter {
      attempts = 0;

      cleanup() {
        this.attempts += 1;
        if (this.attempts === 1)
          throw new Error("controlled synchronous cleanup throw");
        if (this.attempts === 2)
          return Promise.resolve({
            cleaned: false,
            reason: "controlled poll failure",
          });
        this.emit("close", 7, null);
        return Promise.resolve({ cleaned: true, signaled: true });
      }
    }

    const child = new ControlledOwnedProcess();
    const diagnostics: { type: string; reason?: string }[] = [];
    const lifecycle = superviseWindowsOwnedProcess(child, {
      retryIntervalMs: 25,
      onCleanupDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    let completed = false;
    const completion = lifecycle.finished
      .catch((cause: unknown) => cause)
      .then((cause) => {
        completed = true;
        return cause;
      });

    child.emit("error", undefined);
    expect(child.attempts).toBe(1);
    await vi.waitFor(() =>
      expect(diagnostics).toEqual([
        {
          type: "cleanup-failed",
          reason: "controlled synchronous cleanup throw",
        },
      ]),
    );
    expect(completed).toBe(false);

    child.emit("error", new Error("secondary native error"));
    expect(child.attempts).toBe(2);
    await vi.waitFor(() =>
      expect(diagnostics).toEqual([
        {
          type: "cleanup-failed",
          reason: "controlled synchronous cleanup throw",
        },
        { type: "cleanup-failed", reason: "controlled poll failure" },
      ]),
    );
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(25);
    await expect(completion).resolves.toBeUndefined();
    expect(child.attempts).toBe(3);
    expect(diagnostics).toEqual([
      {
        type: "cleanup-failed",
        reason: "controlled synchronous cleanup throw",
      },
      { type: "cleanup-failed", reason: "controlled poll failure" },
      { type: "cleanup-recovered" },
    ]);
  } finally {
    vi.useRealTimers();
  }
});
