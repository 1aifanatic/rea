import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { BrowserScenarioCapturePort } from "./BrowserScenarioCapturePort.js";
import { createBrowserScenarioEvidence } from "./BrowserScenarioEvidence.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { BrowserScenario } from "../domain/browserScenario.js";
import { err, type Result } from "../domain/result.js";
import { completeProviderEvidence } from "./ProviderOperationExecution.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { browserScenarioCaptureSchema } from "../domain/browserScenarioCapture.js";

const OPERATION = "capture_browser_scenario" as const;
const PROVIDER_ID = "rea-playwright-browser-scenario";

/** Execute one controlled browser scenario using its explicit request scope. */
export const captureBrowserScenario = async (
  provider: BrowserScenarioCapturePort | undefined,
  scenario: BrowserScenario,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  if (provider === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        PROVIDER_ID,
        OPERATION,
        "browser scenario provider is not configured",
      ),
    );
  const captured = await provider.captureScenario(scenario, options);
  if (captured.ok)
    return completeProviderEvidence(
      createBrowserScenarioEvidence(
        scenario,
        captured.value,
        provider.identity(),
      ),
      options.signal,
    );
  const partial = captured.error.partialObservation;
  if (
    captured.error instanceof AnalysisCancelledError &&
    partial !== undefined &&
    "kind" in partial &&
    partial.kind === "browser-scenario-observation"
  ) {
    const completedCapture = browserScenarioCaptureSchema.safeParse(
      partial.capture,
    );
    if (
      completedCapture.success &&
      completedCapture.data.steps.every(({ status }) => status === "completed")
    )
      captured.error.partialObservation = createBrowserScenarioEvidence(
        scenario,
        completedCapture.data,
        provider.identity(),
      );
  }
  return captured;
};
