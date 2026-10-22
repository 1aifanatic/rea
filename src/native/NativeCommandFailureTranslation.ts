import type { NativeToolName } from "../contracts/native/nativeToolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import {
  DEFAULT_NATIVE_COMMAND_TIMEOUT_MS,
  fixedNativeAllowance,
  nativeDeadlineRecovery,
} from "../domain/native/nativeDeadlines.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  NATIVE_COMMAND_OUTPUT_BUDGET_BYTES,
  NATIVE_FAILURE_DIAGNOSTIC_BYTES,
  type NativeCommandFailure,
} from "./CommandRunner.js";
import { NATIVE_MACOS_PROVIDER_IDENTITY as IDENTITY } from "./NativeMacOSProviderMetadata.js";

/** Native command allowances that no deadline setting raises. */
export const NATIVE_COMMAND_FIXED_ALLOWANCES = `The ${String(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES)}-byte command output allowance and the ${String(NATIVE_FAILURE_DIAGNOSTIC_BYTES)}-byte failure-diagnostic excerpt have no runtime override.`;

/** How the calling operation applied and exposes the failed command. */
export interface NativeCommandFailureContext {
  /** Applied wall clock; omitted means the default native command deadline. */
  readonly timeoutMs?: number;
  /** Deadline recovery for an operation without native_command_timeout_ms. */
  readonly timeoutRecovery?: {
    readonly userMessage: string;
    readonly remediationAction: string;
  };
  /** Requirement stated when xcrun cannot resolve the tool. */
  readonly unavailableReason?: string;
}

/** Preserve each native command failure class, its output, and its cleanup owners. */
export const translateNativeCommandFailure = (
  operation: NativeToolName,
  failure: NativeCommandFailure,
  context: NativeCommandFailureContext = {},
): AnalysisError => {
  const timeoutMs = context.timeoutMs ?? DEFAULT_NATIVE_COMMAND_TIMEOUT_MS;
  const timeoutRecovery =
    context.timeoutRecovery ??
    nativeDeadlineRecovery({
      timeoutMs,
      setting: "native_command_timeout_ms",
      cliFlag: "--native-command-timeout-ms",
      defaultMs: DEFAULT_NATIVE_COMMAND_TIMEOUT_MS,
      phase: "macOS native command deadline",
      unchanged: NATIVE_COMMAND_FIXED_ALLOWANCES,
    });
  const cleanupOwners = [
    ...failure.cleanupFailures,
    ...(failure.cleanupOwner === undefined
      ? []
      : [
          {
            owner: failure.cleanupOwner,
            marker: failure.cleanupMarker,
            reason:
              failure.cleanupFailure ??
              "native command cleanup remains incomplete",
            resources: failure.cleanupResources,
          },
        ]),
  ];
  const markers = cleanupOwners.flatMap(({ marker }) =>
    marker === undefined ? [] : [marker],
  );
  const bindCleanup = (error: AnalysisError): AnalysisError =>
    cleanupOwners.length === 0 ||
    cleanupOwners.some(({ marker }) => marker === undefined)
      ? error
      : error.bindCleanupDependencies([...new Set(markers)]);
  const preparation = failure.preparationFailure;
  if (preparation !== undefined) {
    const marker = preparation.cleanupFailure;
    const compiler = preparation.compilerOutcome;
    const options = {
      cause: failure,
      ...(preparation.capturedOutput === undefined
        ? {}
        : { capturedOutput: preparation.capturedOutput }),
      ...(marker === undefined
        ? {}
        : {
            cleanup: {
              reason: marker.message,
              resources: marker.cleanupResources,
            },
          }),
      diagnostics: {
        phase: "process-preparation",
        tool: failure.tool,
        reason: failure.reason,
        detail: preparation.message,
        ...(compiler === undefined
          ? {}
          : {
              compiler_outcome: {
                outcome: compiler.outcome,
                code: compiler.code,
                signal: compiler.signal,
                ...(compiler.timeoutMs === undefined
                  ? {}
                  : { timeout_ms: compiler.timeoutMs }),
              },
            }),
      },
    };
    const error =
      preparation.cancellation === undefined
        ? new ProviderAdapterError(IDENTITY.id, operation, options)
        : failure.reason === "timeout"
          ? new AnalysisTimeoutError(operation, timeoutMs, {
              ...options,
              cause: preparation.cancellation.reason,
              ...timeoutRecovery,
            })
          : new AnalysisCancelledError(operation, {
              ...options,
              cause: preparation.cancellation.reason,
            });
    return bindCleanup(
      marker === undefined ? error : error.bindCleanupDependencies([marker]),
    );
  }
  const capturedOutput =
    failure.capture === null
      ? undefined
      : {
          stdout: failure.capture.stdout,
          stderr: failure.capture.stderr,
          truncated: failure.capture.truncated,
          stdout_bytes: failure.capture.stdoutBytes,
          stderr_bytes: failure.capture.stderrBytes,
          exit_code: failure.capture.exitCode,
          signal: failure.capture.signal,
        };
  const cleanup =
    failure.cleanupFailure === null
      ? undefined
      : {
          reason: failure.cleanupFailure,
          resources: [...failure.cleanupResources],
        };
  const errorOptions = {
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
  if (failure.reason === "unavailable") {
    const reason =
      context.unavailableReason ??
      `${failure.tool} is unavailable through xcrun.`;
    return bindCleanup(
      new AnalysisCapabilityUnavailableError(IDENTITY.id, operation, reason, {
        ...errorOptions,
        userMessage: reason,
      }),
    );
  }
  if (failure.reason === "cancelled")
    return bindCleanup(
      new AnalysisCancelledError(operation, {
        ...errorOptions,
        ...(failure.cancellation === undefined
          ? {}
          : { cause: failure.cancellation.reason }),
      }),
    );
  if (failure.reason === "timeout")
    return bindCleanup(
      new AnalysisTimeoutError(operation, timeoutMs, {
        ...errorOptions,
        ...timeoutRecovery,
      }),
    );
  if (failure.reason === "output-limit")
    return bindCleanup(
      new AnalysisResourceConstraintError(
        operation,
        "memory",
        `Native command output exceeded ${String(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES)} bytes. Complete output is required for analysis. This release has no runtime override. native_command_timeout_ms does not raise this allowance.`,
        { max_output_bytes: NATIVE_COMMAND_OUTPUT_BUDGET_BYTES },
        {
          ...errorOptions,
          ...fixedNativeAllowance(
            "The native command output capture allowance",
            "capture",
            `${String(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES)} bytes`,
          ),
        },
      ),
    );
  return bindCleanup(
    new ProviderAdapterError(IDENTITY.id, operation, {
      cause: failure,
      ...errorOptions,
      diagnostics: {
        tool: failure.tool,
        reason: failure.reason,
        exit_code: failure.capture?.exitCode ?? failure.exitCode,
        signal: failure.capture?.signal ?? null,
        stdout_bytes: failure.capture?.stdoutBytes ?? 0,
        stderr_bytes: failure.capture?.stderrBytes ?? 0,
        ...(failure.detail === null ? {} : { detail: failure.detail }),
      },
    }),
  );
};
