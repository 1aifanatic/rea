import type { ElectronApplication, JSHandle, Page } from "playwright-core";
import { z } from "zod";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import {
  electronActiveTimelineEventSchema,
  type ElectronActiveObservationInput,
  type ElectronActiveObservationResult,
} from "../domain/javascript/electronActiveObservation.js";

const OPERATION = "capture_electron_scenario" as const;

const hookSnapshotSchema = z.strictObject({
  events: z.array(electronActiveTimelineEventSchema),
  retention_budget_bytes: z.number().int().min(0),
  estimated_retained_bytes: z.number().int().min(0),
  event_serialized_byte_upper_bound: z.number().int().min(0),
  retained: z.number().int().min(0),
  dropped: z.number().int().min(0),
  dropped_ipc: z.number().int().min(0),
  dropped_runtime: z.number().int().min(0),
  dropped_event_families: z.array(
    z.strictObject({
      family: z.string().min(1),
      count: z.number().int().min(1),
    }),
  ),
  dropped_event_roles: z.array(
    z.strictObject({
      role: z.string().min(1),
      count: z.number().int().min(1),
    }),
  ),
  observed: z.number().int().min(0),
  observed_ipc: z.number().int().min(0),
  observed_runtime: z.number().int().min(0),
  hook_error: z.boolean(),
});

const metricSchema = z.strictObject({
  pid: z.number().int().min(1),
  type: z.string().min(1),
  name: z.string().nullable(),
  service_name: z.string().nullable(),
});

const windowMetadataSchema = z.strictObject({
  window_id: z.string(),
  web_contents_id: z.string(),
  url: z.string(),
  title: z.string(),
  visible: z.boolean().nullable(),
  destroyed: z.boolean(),
});

type ElectronAction = ElectronActiveObservationInput["actions"][number];
type ElectronActions = ElectronActiveObservationResult["actions"];

export type ElectronHookSnapshot = z.infer<typeof hookSnapshotSchema>;
export type ElectronHookEvent = z.infer<
  typeof electronActiveTimelineEventSchema
>;
export type ElectronMetrics = z.infer<typeof metricSchema>[];
type ElectronWindowMetadata = z.infer<typeof windowMetadataSchema>;

/** Run explicit actions against provider-owned Electron windows. */
export const runElectronActions = async (
  application: ElectronApplication,
  input: ElectronActiveObservationInput,
  options: ExecutionOptions,
): Promise<ElectronActions> => {
  const actions: ElectronActions = [];
  for (const action of input.actions) {
    const actionStartedAt = performance.now();
    const windowIndex = actionWindowIndex(action);
    let selectedWindow: Page | undefined;
    let selectedTarget: string | null = null;
    let windowHandle: JSHandle | undefined;
    try {
      if (options.signal?.aborted === true)
        throw new BrowserObservationError(OPERATION, "cancelled");
      selectedWindow =
        windowIndex === null
          ? undefined
          : await waitForWindow({
              application,
              windowIndex,
              signal: options.signal,
            });
      const resolved = await resolveWindowHandleAndTarget({
        application,
        selectedWindow,
        signal: options.signal,
      });
      windowHandle = resolved.handle;
      selectedTarget = resolved.target;
      if (
        (action.kind === "click" ||
          action.kind === "renderer-reload" ||
          action.kind === "renderer-crash") &&
        selectedWindow === undefined
      )
        throw new BrowserObservationError(OPERATION, "window_not_found");

      await runAction({
        application,
        action,
        selectedWindow,
        windowHandle,
        options,
      });
      actions.push({
        step_id: action.step_id,
        kind: action.kind,
        window_index: windowIndex,
        target: selectedTarget,
        status: "completed",
        elapsed_ms: Math.max(
          0,
          Math.round(performance.now() - actionStartedAt),
        ),
        error: null,
      });
    } catch (cause: unknown) {
      actions.push({
        step_id: action.step_id,
        kind: action.kind,
        window_index: windowIndex,
        target: selectedTarget,
        status: options.signal?.aborted ? "cancelled" : "failed",
        elapsed_ms: Math.max(
          0,
          Math.round(performance.now() - actionStartedAt),
        ),
        error: safeActionErrorMessage(cause),
      });
      break;
    } finally {
      if (windowHandle !== undefined) {
        try {
          await windowHandle.dispose();
        } catch {
          // Suppress handle disposal errors to preserve primary action failure or outcome.
        }
      }
    }
  }
  return actions;
};

const resolveWindowHandleAndTarget = async ({
  application,
  selectedWindow,
  signal,
}: {
  readonly application: ElectronApplication;
  readonly selectedWindow: Page | undefined;
  readonly signal: AbortSignal | undefined;
}): Promise<{
  readonly handle: JSHandle | undefined;
  readonly target: string | null;
}> => {
  if (
    selectedWindow === undefined ||
    typeof application.browserWindow !== "function"
  ) {
    return { handle: undefined, target: null };
  }
  let handle: JSHandle | undefined;
  try {
    handle = await runWithExecutionLimits(
      application.browserWindow(selectedWindow),
      signal,
    );
  } catch (cause: unknown) {
    if (signal?.aborted) throw cause;
    return { handle: undefined, target: null };
  }
  if (handle === undefined) {
    return { handle: undefined, target: null };
  }
  try {
    const windowId: unknown = await runWithExecutionLimits(
      handle.evaluate((win: unknown) => {
        const candidate = win as
          | {
              readonly id?: unknown;
              isDestroyed?: () => boolean;
            }
          | null
          | undefined;
        if (candidate === null || candidate === undefined) return null;
        if (
          typeof candidate.isDestroyed === "function" &&
          candidate.isDestroyed()
        )
          return null;
        return typeof candidate.id === "number" ? candidate.id : null;
      }),
      signal,
    );
    return {
      handle,
      target:
        typeof windowId === "number" ? `window:${String(windowId)}` : null,
    };
  } catch (cause: unknown) {
    if (signal?.aborted) throw cause;
    return { handle, target: null };
  }
};

type RunActionContext = {
  readonly application: ElectronApplication;
  readonly action: ElectronAction;
  readonly selectedWindow: Page | undefined;
  readonly windowHandle: JSHandle | undefined;
  readonly options: ExecutionOptions;
};

const runAction = async ({
  application,
  action,
  selectedWindow,
  windowHandle,
  options,
}: RunActionContext): Promise<void> => {
  switch (action.kind) {
    case "click":
      if (selectedWindow === undefined)
        throw new BrowserObservationError(OPERATION, "window_not_found");
      await runWithExecutionLimits(
        selectedWindow.locator(action.selector).click({
          timeout: 0,
        }),
        options.signal,
      );
      return;
    case "wait": {
      const page =
        selectedWindow ??
        (await application.firstWindow({
          timeout: 0,
        }));
      await runWithExecutionLimits(
        page.waitForTimeout(action.duration_ms),
        options.signal,
      );
      return;
    }
    case "renderer-reload":
      if (selectedWindow === undefined)
        throw new BrowserObservationError(OPERATION, "window_not_found");
      await runWithExecutionLimits(
        selectedWindow.reload({
          timeout: 0,
        }),
        options.signal,
      );
      return;
    case "renderer-crash": {
      if (windowHandle === undefined)
        throw new BrowserObservationError(OPERATION, "window_not_found");
      const crashed = await runWithExecutionLimits(
        windowHandle.evaluate((win: unknown) => {
          const candidate = win as
            | {
                readonly isDestroyed?: () => boolean;
                readonly webContents?: {
                  forcefullyCrashRenderer?: () => void;
                };
              }
            | null
            | undefined;
          if (candidate === null || candidate === undefined) return false;
          if (
            typeof candidate.isDestroyed === "function" &&
            candidate.isDestroyed()
          )
            return false;
          if (
            typeof candidate.webContents?.forcefullyCrashRenderer !== "function"
          )
            return false;
          candidate.webContents.forcefullyCrashRenderer();
          return true;
        }),
        options.signal,
      );
      if (!crashed)
        throw new BrowserObservationError(OPERATION, "window_not_found");
      return;
    }
    case "deep-link":
      await runWithExecutionLimits(
        emitDeepLink(application, action),
        options.signal,
      );
      return;
  }
};

const actionWindowIndex = (action: ElectronAction): number | null => {
  switch (action.kind) {
    case "click":
    case "renderer-reload":
    case "renderer-crash":
      return action.window_index;
    case "wait":
      return action.window_index ?? null;
    case "deep-link":
      return null;
  }
};

type WaitForWindowContext = {
  readonly application: ElectronApplication;
  readonly windowIndex: number;
  readonly signal: AbortSignal | undefined;
};

const waitForWindow = async ({
  application,
  windowIndex,
  signal,
}: WaitForWindowContext): Promise<Page> => {
  while (true) {
    if (signal?.aborted === true)
      throw new BrowserObservationError(OPERATION, "cancelled");
    const window = application.windows()[windowIndex];
    if (window !== undefined) return window;
    await runWithExecutionLimits(
      new Promise<void>((resolve) => setTimeout(resolve, 25)),
      signal,
    );
  }
};

const emitDeepLink = (
  application: ElectronApplication,
  action: Extract<ElectronAction, { kind: "deep-link" }>,
): Promise<boolean> =>
  application.evaluate(
    ({ app }, payload) => {
      if (payload.delivery === "open-url")
        return app.emit(
          "open-url",
          { preventDefault: () => undefined },
          payload.url,
        );
      return app.emit("second-instance", {}, [payload.url], "", {});
    },
    { delivery: action.delivery, url: action.url },
  );

/** Read the current Electron windows, metrics, and hook snapshot. */
// oxlint-disable-next-line max-lines-per-function -- one state read must share one capture boundary.
export const readApplicationState = async (
  application: ElectronApplication,
): Promise<{
  readonly windows: ReadonlyArray<{
    readonly window_id: string;
    readonly web_contents_id: string;
    readonly url: string;
    readonly title: string;
    readonly visible: boolean | null;
    readonly destroyed: boolean;
  }>;
  readonly metrics: ElectronMetrics;
  readonly electronVersion: string;
  readonly hookSnapshot: ElectronHookSnapshot;
}> => {
  const windowMetadataPromise: Promise<ElectronWindowMetadata[]> = application
    .evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(
        (window: {
          readonly id: number;
          readonly webContents: {
            readonly id: number;
            getURL(): string;
            getTitle(): string;
          };
          isDestroyed(): boolean;
          isVisible(): boolean;
        }) => ({
          window_id: `window:${String(window.id)}`,
          web_contents_id: `webContents:${String(window.webContents.id)}`,
          url: window.webContents.getURL(),
          title: window.webContents.getTitle(),
          visible: window.isDestroyed() ? null : window.isVisible(),
          destroyed: window.isDestroyed(),
        }),
      ),
    )
    .then((value) => z.array(windowMetadataSchema).parse(value));
  const processMetricsPromise: Promise<ElectronMetrics> = application
    .evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map(
          (metric: {
            readonly pid: number;
            readonly type: string;
            readonly name?: string;
            readonly serviceName?: string;
          }) => ({
            pid: metric.pid,
            type: metric.type,
            name: metric.name ?? null,
            service_name: metric.serviceName ?? null,
          }),
        ),
    )
    .then((value) => z.array(metricSchema).parse(value));
  const electronVersionPromise: Promise<string> = application
    .evaluate(() => process.versions.electron)
    .then((value) => z.string().parse(value));
  const hookSnapshotPromise: Promise<ElectronHookSnapshot> = application
    .evaluate(() => {
      const candidate = Reflect.get(globalThis, "__reaElectronActiveSnapshot");
      return typeof candidate === "function"
        ? candidate()
        : {
            events: [],
            retention_budget_bytes: 0,
            estimated_retained_bytes: 0,
            event_serialized_byte_upper_bound: 0,
            retained: 0,
            dropped: 0,
            dropped_ipc: 0,
            dropped_runtime: 0,
            dropped_event_families: [],
            dropped_event_roles: [],
            observed: 0,
            observed_ipc: 0,
            observed_runtime: 0,
            hook_error: true,
          };
    })
    .then((value) => hookSnapshotSchema.parse(value));
  const [windowMetadata, processMetrics, electronVersion, hookSnapshot] =
    await Promise.all([
      windowMetadataPromise,
      processMetricsPromise,
      electronVersionPromise,
      hookSnapshotPromise,
    ]);
  return {
    windows: windowMetadata,
    metrics: processMetrics,
    electronVersion,
    hookSnapshot,
  };
};

/** Apply an optional lifecycle deadline and caller cancellation to an operation. */
export const runWithExecutionLimits = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal | undefined,
  deadline?: number,
): Promise<Value> => {
  if (signal?.aborted === true)
    throw new BrowserObservationError(OPERATION, "cancelled");
  if (signal === undefined && deadline === undefined) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interruptions: Promise<never>[] = [];
  if (deadline !== undefined)
    interruptions.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BrowserObservationError(OPERATION, "timeout")),
          Math.max(1, deadline - performance.now()),
        );
      }),
    );
  if (signal !== undefined)
    interruptions.push(
      new Promise<never>((_, reject) => {
        abortListener = () =>
          reject(new BrowserObservationError(OPERATION, "cancelled"));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    );
  try {
    return interruptions.length === 0
      ? await operation
      : await Promise.race([operation, ...interruptions]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined)
      signal?.removeEventListener("abort", abortListener);
  }
};

const safeActionErrorMessage = (cause: unknown): string => {
  return cause instanceof Error ? cause.message : "Electron action failed";
};
