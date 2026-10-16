import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { getHeapStatistics } from "node:v8";

import { getManyValues, isMany, none } from "stream-chain/defs.js";
import { jsonParser, type Token } from "stream-json/core/parser.js";
import { z } from "zod";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import type { analysisStringSchema } from "../domain/hopperValues.js";
import { err, ok, type Result } from "../domain/result.js";
import { compareKunaAddresses } from "./KunaAddress.js";
import { kunaAddressFromJsonNumber } from "./KunaJson.js";
import { KUNA_STRING_MIN_LENGTH } from "./KunaLimits.js";

const PRODUCER = "kuna:strings";
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const address = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/u);
const header = z.object({
  binary: z.string(),
  encoding: z.literal("all"),
  min_length: z.literal(KUNA_STRING_MIN_LENGTH),
  filter: z.null(),
  section: z.null(),
  termination: z.literal("any"),
  scanned: z.enum(["sections", "segments"]),
  xrefs: z.literal(false),
  count,
});
const row = z.object({
  address,
  address_hex: address,
  text: z.string(),
  length: count,
  byte_length: count,
  nul_terminated: z.boolean(),
  encoding: z.enum(["ascii", "utf8", "utf16"]),
  section: z.string().nullable(),
  xrefs_count: z.literal(0),
  functions: z.tuple([]),
});

const HEADER_KEYS: ReadonlySet<string> = new Set(Object.keys(header.shape));
const ROW_KEYS: ReadonlySet<string> = new Set(Object.keys(row.shape));

/** Charge for one retained row beyond its UTF-16 text: item, facts and address. */
const ROW_OVERHEAD_BYTES = 256;
/** Projected retention admitted between heap samples. */
const ADMISSION_INTERVAL_BYTES = 64 * 1024;
/** Per-row reserve for the rows array's growth, its sort and a regex projection. */
const ROW_REFERENCE_BYTES = 16;

/** JSON text omits terminators; native lengths describe the encoded source. */
const validateStringFacts = (entry: z.infer<typeof row>): void => {
  let characters = 0;
  for (const character of entry.text) {
    const point = character.codePointAt(0)!;
    if (
      point === 0 ||
      (point >= 0xd800 && point <= 0xdfff) ||
      (entry.encoding === "ascii" && point > 0x7f) ||
      (entry.encoding === "utf16" && point > 0xff)
    )
      throw new Error("string text contradicts its reported encoding");
    characters += 1;
  }
  const textBytes =
    entry.encoding === "utf16"
      ? entry.text.length * 2
      : entry.encoding === "ascii"
        ? entry.text.length
        : Buffer.byteLength(entry.text);
  const terminatorBytes = entry.nul_terminated
    ? entry.encoding === "utf16"
      ? 2
      : 1
    : 0;
  if (
    characters < KUNA_STRING_MIN_LENGTH ||
    entry.length !== characters ||
    entry.byte_length !== textBytes + terminatorBytes
  )
    throw new Error(
      "string length or termination contradicts its encoded text",
    );
};

export type KunaStringItem = z.infer<typeof analysisStringSchema>;

export interface KunaStringInventory {
  readonly items: readonly KunaStringItem[];
  readonly sha256: string;
  readonly bytes: number;
  readonly scanned: "sections" | "segments";
}

const unusable = (reason: string): AnalysisOutputError =>
  new AnalysisOutputError(PRODUCER, reason, {
    userMessage: `Kuna's string inventory cannot be used: ${reason}`,
  });

const scalar = (token: Token): unknown => {
  switch (token.name) {
    case "stringValue":
    case "nullValue":
    case "trueValue":
    case "falseValue":
      return token.value;
    case "numberValue":
      return Number(token.value);
    default:
      throw new Error(`unexpected JSON ${token.name}`);
  }
};

const isScalar = (token: Token): boolean =>
  token.name === "stringValue" ||
  token.name === "numberValue" ||
  token.name === "nullValue" ||
  token.name === "trueValue" ||
  token.name === "falseValue";

/**
 * Validate one `kuna strings --json` document as Kuna writes it. Rows are
 * checked and retained one at a time, so the scan's JSON is never buffered;
 * retention is admitted against live heap headroom. The first contradiction
 * aborts `rejected`, letting the owner stop Kuna early. The writable side
 * never fails: the command's own outcome stays authoritative, and `finish`
 * reports what the document established.
 */
export class KunaStringInventoryReader extends Writable {
  readonly #hash = createHash("sha256");
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #tokens = jsonParser({
    packKeys: true,
    packStrings: true,
    packNumbers: true,
    streamValues: false,
  });
  readonly #rejection = new AbortController();
  readonly #header = new Map<string, unknown>();
  readonly #rootKeys = new Set<string>();
  readonly #items: KunaStringItem[] = [];
  readonly #identities = new Set<string>();
  #bytes = 0;
  #failure: AnalysisError | undefined;
  /** 0 before the root, 1 in the root object, 2 in `strings`, 3 in a row, 4 in its `functions`. */
  #depth = 0;
  #closed = false;
  #stringsSeen = false;
  #key: string | undefined;
  /** Containers still open inside an ignored root member. */
  #skipping = 0;
  #row: Record<string, unknown> | undefined;
  #projectedBytes = 0;
  #nextAdmission = 0;

  /** Aborted at the first contradiction or refused retention. */
  get rejected(): AbortSignal {
    return this.#rejection.signal;
  }

  /** Why `rejected` aborted, if it has. */
  get rejection(): AnalysisError | undefined {
    return this.#rejection.signal.aborted ? this.#failure : undefined;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.#failure === undefined)
      try {
        this.#bytes += chunk.byteLength;
        this.#hash.update(chunk);
        this.#feed(this.#decoder.decode(chunk, { stream: true }));
      } catch (cause: unknown) {
        this.#reject(cause);
        this.#rejection.abort();
      }
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    // Kuna has stopped writing, so an incomplete document is recorded for
    // `finish` without signalling: its exit status may explain it.
    if (this.#failure === undefined)
      try {
        this.#feed(this.#decoder.decode());
        this.#feed(none);
      } catch (cause: unknown) {
        this.#reject(cause);
      }
    callback();
  }

  /** The validated inventory, once the producer has exited successfully. */
  finish(input: string): Result<KunaStringInventory, AnalysisError> {
    if (this.#failure !== undefined) return err(this.#failure);
    if (!this.writableFinished || !this.#closed || !this.#stringsSeen)
      return err(unusable("the string inventory ended before it was complete"));
    const fields = header.safeParse(Object.fromEntries(this.#header));
    if (!fields.success)
      return err(unusable("the string inventory header is not Kuna's scan"));
    if (fields.data.binary !== input)
      return err(unusable("string inventory names a different input"));
    if (fields.data.count !== this.#items.length)
      return err(
        unusable("string inventory count disagrees with examined rows"),
      );
    this.#items.sort(
      (left, right) =>
        compareKunaAddresses(left.address, right.address) ||
        (left.string?.encoding ?? "").localeCompare(
          right.string?.encoding ?? "",
          "en",
        ),
    );
    return ok({
      items: this.#items,
      sha256: this.#hash.digest("hex"),
      bytes: this.#bytes,
      scanned: fields.data.scanned,
    });
  }

  #reject(cause: unknown): void {
    this.#failure ??=
      cause instanceof AnalysisResourceConstraintError
        ? cause
        : unusable(cause instanceof Error ? cause.message : String(cause));
    this.#items.length = 0;
    this.#identities.clear();
  }

  #feed(text: string | typeof none): void {
    const tokens = this.#tokens(text);
    if (isMany(tokens))
      for (const token of getManyValues(tokens)) this.#consume(token);
  }

  #consume(token: Token): void {
    if (this.#skipping > 0) {
      if (token.name === "startObject" || token.name === "startArray")
        this.#skipping += 1;
      else if (token.name === "endObject" || token.name === "endArray")
        this.#skipping -= 1;
      return;
    }
    switch (this.#depth) {
      case 0:
        if (token.name !== "startObject" || this.#closed)
          throw new Error("string inventory is not one JSON object");
        this.#depth = 1;
        return;
      case 1:
        return this.#consumeMember(token);
      case 2:
        if (token.name === "startObject") {
          // Only schema keys are stored, so a plain object keeps one shape.
          this.#row = {};
          this.#key = undefined;
          this.#depth = 3;
        } else if (token.name === "endArray") {
          this.#stringsSeen = true;
          this.#depth = 1;
        } else throw new Error("string inventory row is not an object");
        return;
      case 3:
        return this.#consumeRowField(token);
      default:
        // Rows are scanned with --no-xrefs, so `functions` must be empty.
        if (token.name !== "endArray")
          throw new Error("string row reports referencing functions");
        this.#row![this.#key!] = [];
        this.#depth = 3;
    }
  }

  #consumeMember(token: Token): void {
    if (token.name === "keyValue") {
      if (this.#rootKeys.has(token.value))
        throw new Error(`string inventory repeats ${token.value}`);
      this.#rootKeys.add(token.value);
      this.#key = token.value;
      return;
    }
    if (token.name === "endObject") {
      this.#depth = 0;
      this.#closed = true;
      return;
    }
    const key = this.#key;
    this.#key = undefined;
    if (key === "strings") {
      if (token.name !== "startArray")
        throw new Error("string inventory rows are not an array");
      this.#depth = 2;
    } else if (key !== undefined && HEADER_KEYS.has(key)) {
      if (!isScalar(token))
        throw new Error(`string inventory ${key} is not a scalar`);
      this.#header.set(key, scalar(token));
    } else this.#ignore(token);
  }

  /** Skip a value this reader does not interpret, without retaining it. */
  #ignore(token: Token): void {
    if (token.name === "startObject" || token.name === "startArray")
      this.#skipping = 1;
  }

  #consumeRowField(token: Token): void {
    const fields = this.#row!;
    if (token.name === "keyValue") {
      if (Object.hasOwn(fields, token.value))
        throw new Error(`string row repeats ${token.value}`);
      this.#key = ROW_KEYS.has(token.value) ? token.value : undefined;
      return;
    }
    if (token.name === "endObject") {
      this.#retain(fields);
      this.#row = undefined;
      this.#depth = 2;
      return;
    }
    const key = this.#key;
    if (key === undefined) return this.#ignore(token);
    if (key === "functions" && token.name === "startArray") {
      this.#depth = 4;
      return;
    }
    if (!isScalar(token)) throw new Error(`string row ${key} is not a scalar`);
    fields[key] =
      key === "address"
        ? kunaAddressFromJsonNumber(
            token.name === "numberValue" ? token.value : undefined,
            key,
          )
        : scalar(token);
    this.#key = undefined;
  }

  #retain(fields: Record<string, unknown>): void {
    const parsed = row.safeParse(fields);
    if (!parsed.success)
      throw new Error(
        `string row field ${parsed.error.issues[0]?.path.join(".") ?? ""} is not Kuna's`,
      );
    const entry = parsed.data;
    validateStringFacts(entry);
    if (entry.address !== entry.address_hex)
      throw new Error("string address disagrees with its hex field");
    const identity = `${entry.address}:${entry.encoding}`;
    if (this.#identities.has(identity))
      throw new Error("string inventory repeats an identity");
    this.#admit(entry.text.length);
    this.#identities.add(identity);
    this.#items.push({
      address: entry.address,
      value: entry.text,
      string: {
        encoding: entry.encoding,
        encoding_status: "observed",
        termination: entry.nul_terminated
          ? "present_or_not_required"
          : "missing",
        byte_length: entry.byte_length,
      },
    });
  }

  /** Admit retention against live headroom rather than a fixed scan size. */
  #admit(codeUnits: number): void {
    this.#projectedBytes += ROW_OVERHEAD_BYTES + codeUnits * 2;
    if (this.#projectedBytes < this.#nextAdmission) return;
    const heap = getHeapStatistics();
    const requiredBytes =
      ADMISSION_INTERVAL_BYTES + (this.#items.length + 1) * ROW_REFERENCE_BYTES;
    if (requiredBytes > heap.total_available_size)
      throw new AnalysisResourceConstraintError(
        PRODUCER,
        "memory",
        `Insufficient heap headroom to retain more than ${String(this.#items.length)} Kuna string rows`,
        {
          retained_rows: this.#items.length,
          projected_retained_bytes: this.#projectedBytes,
          required_headroom_bytes: requiredBytes,
          available_heap_bytes: heap.total_available_size,
          heap_size_limit_bytes: heap.heap_size_limit,
        },
        {
          remediationAction:
            "Close other targets in this REA process, or start REA with a larger Node.js heap (--max-old-space-size), then reopen the target.",
        },
      );
    this.#nextAdmission = this.#projectedBytes + ADMISSION_INTERVAL_BYTES;
  }
}
