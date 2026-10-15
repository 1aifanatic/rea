import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ElectronObservationPort } from "./ElectronObservationPort.js";
import type { Evidence } from "../../domain/evidence.js";
import type {
  InspectElectronPageInput,
  ListElectronTargetsInput,
} from "../../domain/javascript/electronObservation.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../domain/result.js";
import { createElectronEvidence } from "./ElectronEvidence.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

/** List local file pages exposed by the explicitly selected endpoint. */
export const listElectronTargets = async (
  provider: ElectronObservationPort | undefined,
  input: ListElectronTargetsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireProvider(provider, "list_electron_targets");
  if (!ready.ok) return ready;
  const result = await ready.value.listTargets(input, options);
  return result.ok
    ? completeProviderEvidence(
        createElectronEvidence(
          "list_electron_targets",
          input,
          result.value,
          ready.value.identity(),
        ),
        options.signal,
      )
    : result;
};

/** Inspect one local file page from the explicitly selected endpoint. */
export const inspectElectronPage = async (
  provider: ElectronObservationPort | undefined,
  input: InspectElectronPageInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireProvider(provider, "inspect_electron_page");
  if (!ready.ok) return ready;
  const result = await ready.value.inspectPage(input, options);
  return result.ok
    ? completeProviderEvidence(
        createElectronEvidence(
          "inspect_electron_page",
          input,
          result.value,
          ready.value.identity(),
        ),
        options.signal,
      )
    : retainCompletedElectronPartial(result, input, ready.value.identity());
};

const retainCompletedElectronPartial = (
  result: Result<Evidence, AnalysisError>,
  input: InspectElectronPageInput,
  provider: ReturnType<ElectronObservationPort["identity"]>,
): Result<Evidence, AnalysisError> => {
  if (
    result.ok ||
    !(result.error instanceof AnalysisCancelledError) ||
    result.error.partialObservation === undefined ||
    !("kind" in result.error.partialObservation) ||
    result.error.partialObservation.kind !== "electron-page-observation"
  )
    return result;
  const partial = result.error.partialObservation;
  const inspection = {
    ...partial.inspection,
    limitations: [
      ...partial.inspection.limitations,
      partial.cleanup === "transport-closed"
        ? "REA closed its CDP transport; this does not imply target shutdown."
        : "CDP transport cleanup remains incomplete.",
    ],
  };
  const evidence = createElectronEvidence(
    "inspect_electron_page",
    input,
    inspection,
    provider,
  );
  result.error.partialObservation = evidence;
  return result;
};

const requireProvider = (
  provider: ElectronObservationPort | undefined,
  operation: "list_electron_targets" | "inspect_electron_page",
): Result<ElectronObservationPort, AnalysisError> =>
  provider === undefined
    ? err(
        new AnalysisCapabilityUnavailableError(
          "rea-cdp-electron",
          operation,
          "Electron observation provider is not configured",
        ),
      )
    : ok(provider);
