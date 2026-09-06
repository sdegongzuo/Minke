/**
 * Console and network capture for the Agent Browser.
 *
 * `AgentBrowserCdp` owns the debugger session and forwards the CDP events it
 * already receives. This collector only classifies, bounds, filters, remaps
 * and buffers them, and never sends a command of its own.
 *
 * Capture itself is marked here; the CDP/runtime layer decides when to enable
 * domains (session auto-enable when Agent debug is on, explicit `enable`, or
 * execute). Body fetch, HTTP source-map fetch, snapshot-ref binding, and
 * wait timeouts stay on that I/O path.
 */

export const MAX_DEBUG_CONSOLE_MESSAGES = 200;
/** Same cap as console / Harness `MAX_AGENT_BROWSER_DEBUG_LIMIT`. */
export const MAX_DEBUG_NETWORK_REQUESTS = MAX_DEBUG_CONSOLE_MESSAGES;

export const MAX_DEBUG_TEXT_LENGTH = 2_000;
const MAX_URL_LENGTH = 2_048;
/** Mirrors the contract parser caps so a collector view cannot fail parse. */
const MAX_FUNCTION_NAME_LENGTH = 500;
const MAX_NETWORK_METHOD_LENGTH = 32;
const MAX_RESOURCE_TYPE_LENGTH = 64;
const MAX_BLOCKED_REASON_LENGTH = 200;
export const DEBUG_TRUNCATION_SUFFIX = "... <truncated>";
export const REDACTED_HEADER_VALUE = "[redacted]";
const REDACTED_HEADER_NAMES = new Set(["cookie", "authorization"]);

export const AGENT_BROWSER_CONSOLE_LEVELS = [
  "log",
  "debug",
  "info",
  "warn",
  "error",
] as const;
export type AgentBrowserConsoleLevel =
  typeof AGENT_BROWSER_CONSOLE_LEVELS[number];

export const AGENT_BROWSER_NETWORK_RESOURCE_TYPES = [
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "xhr",
  "fetch",
  "eventsource",
  "websocket",
  "manifest",
  "other",
] as const;
export type AgentBrowserNetworkResourceType =
  typeof AGENT_BROWSER_NETWORK_RESOURCE_TYPES[number];

/**
 * Where a console entry came from. Distinguishing them matters for frontend
 * debugging: `console.*` calls and framework warnings are `console`, while
 * resource failures, CSP violations and deprecations arrive as `browser`.
 */
export type AgentBrowserConsoleSource = "console" | "exception" | "browser";

export interface AgentBrowserStackFrame {
  readonly url?: string;
  readonly line?: number;
  readonly column?: number;
  readonly functionName?: string;
}

export interface AgentBrowserConsoleMessage {
  readonly id: number;
  readonly level: AgentBrowserConsoleLevel;
  readonly source: AgentBrowserConsoleSource;
  readonly text: string;
  /** Wall-clock capture time in milliseconds. */
  readonly timestamp: number;
  readonly url?: string;
  readonly line?: number;
  readonly column?: number;
  /** Shallow JSON-serialized arguments; present only on id drill-down. */
  readonly args?: readonly unknown[];
  /** Full remapped stack; present only on id drill-down. */
  readonly stack?: readonly AgentBrowserStackFrame[];
}

export type AgentBrowserNetworkOutcome = "pending" | "finished" | "failed";

export interface AgentBrowserNetworkRequest {
  readonly id: number;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly outcome: AgentBrowserNetworkOutcome;
  /** Wall-clock capture time in milliseconds. */
  readonly timestamp: number;
  readonly status?: number;
  readonly statusText?: string;
  readonly mimeType?: string;
  readonly encodedDataLength?: number;
  readonly durationMs?: number;
  readonly errorText?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly requestBody?: string;
  readonly body?: string;
  readonly initiator?: AgentBrowserStackFrame;
  readonly blockedReason?: string;
}

export interface AgentBrowserConsoleView {
  readonly enabled: boolean;
  readonly messages: readonly AgentBrowserConsoleMessage[];
  /** Oldest entries were dropped; `messages` is the newest slice. */
  readonly truncated: boolean;
  readonly totalCount: number;
  /** High-water id across the collector, including dropped entries. */
  readonly lastId: number;
}

export interface AgentBrowserNetworkView {
  readonly enabled: boolean;
  readonly requests: readonly AgentBrowserNetworkRequest[];
  readonly truncated: boolean;
  readonly totalCount: number;
  /** High-water id across the collector, including dropped entries. */
  readonly lastId: number;
}

export interface AgentBrowserConsoleQuery {
  readonly levels?: readonly AgentBrowserConsoleLevel[];
  readonly limit?: number;
  readonly id?: number;
  readonly sinceId?: number;
}

/**
 * Resource types omitted from the default network view. A Vite-style dev
 * server emits one Script/Stylesheet request per module; those rows would
 * otherwise drown Document/XHR/Fetch traffic. An explicit `resourceTypes`
 * filter still returns them.
 */
export const DEFAULT_HIDDEN_NETWORK_RESOURCE_TYPES = [
  "script",
  "stylesheet",
] as const;

export interface AgentBrowserNetworkQuery {
  readonly resourceTypes?: readonly string[];
  readonly limit?: number;
  /**
   * Keep only requests that failed at the network layer or answered 4xx/5xx.
   */
  readonly failuresOnly?: boolean;
  readonly id?: number;
  readonly sinceId?: number;
  readonly urlContains?: string;
}

export interface AgentBrowserPendingSourceMap {
  readonly scriptUrl: string;
  readonly sourceMapUrl: string;
}

/**
 * Restricted debug evaluation outcome. `value` is the JSON serialization of
 * the function's return value; `errorText` is set when the function threw or
 * returned something JSON cannot represent. Exactly one is present.
 */
export interface AgentBrowserExecuteOutcome {
  readonly ok: boolean;
  readonly value?: string;
  readonly errorText?: string;
}

/**
 * Page-side wrapper for restricted debug evaluation. It is installed on the
 * function object via Runtime.callFunctionOn: `this` is the evaluated
 * function expression, the first argument carries the awaitPromise decision,
 * and the remaining arguments are the JSON call arguments. Everything the
 * wrapper touches is wrapped so a throwing or never-serializable function
 * surfaces as a structured error instead of a protocol failure.
 */
export const DEBUG_EXECUTE_WRAPPER_FUNCTION = `async function (awaitPromise) {
  try {
    let result = this.apply(null, Array.prototype.slice.call(arguments, 1));
    if (awaitPromise === true && result !== null && result !== undefined &&
        typeof result.then === "function") {
      result = await result;
    }
    try {
      return { ok: true, value: JSON.stringify(result) };
    } catch {
      return { ok: false, error: "Return value is not JSON-serializable" };
    }
  } catch (error) {
    return { ok: false, error: String(
      error && error.stack ? error.stack : error,
    ) };
  }
}`;

export interface AgentBrowserDebugCollectorOptions {
  readonly maxConsoleMessages?: number;
  readonly maxNetworkRequests?: number;
}

type NetworkEntry = {
  id: number;
  cdpRequestId: string;
  method: string;
  url: string;
  resourceType: string;
  wallClock: number;
  /** CDP monotonic timestamp in seconds; only used to derive `durationMs`. */
  startedAt?: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  encodedDataLength?: number;
  durationMs?: number;
  outcome: AgentBrowserNetworkOutcome;
  errorText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  initiator?: AgentBrowserStackFrame;
  blockedReason?: string;
  requestBody?: string;
  needsPostData?: boolean;
  body?: string;
};

type ConsoleEntry = {
  id: number;
  level: AgentBrowserConsoleLevel;
  source: AgentBrowserConsoleSource;
  text: string;
  timestamp: number;
  frames: readonly AgentBrowserStackFrame[];
  args: readonly unknown[];
};

type Location = AgentBrowserStackFrame;

type SourceMapSegment = {
  readonly generatedColumn: number;
  readonly sourceIndex: number;
  readonly originalLine: number;
  readonly originalColumn: number;
};

type SourceMapBindings = {
  readonly sources: readonly string[];
  readonly lines: readonly (readonly SourceMapSegment[])[];
};

type NetworkWaiter = {
  readonly query: AgentBrowserNetworkQuery;
  readonly resolve: (view: AgentBrowserNetworkView) => void;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Bound `value` to `max` characters, including the truncation suffix.
 * The suffix is part of the cap so a later contract parse cannot reject
 * a collector view that this function just produced.
 */
export function truncateDebugText(value: string, max: number): string {
  if (value.length <= max) return value;
  if (DEBUG_TRUNCATION_SUFFIX.length >= max) {
    return DEBUG_TRUNCATION_SUFFIX.slice(0, max);
  }
  return `${value.slice(0, max - DEBUG_TRUNCATION_SUFFIX.length)}${DEBUG_TRUNCATION_SUFFIX}`;
}

function callFramesOf(value: unknown): readonly AgentBrowserStackFrame[] {
  const frames = list(record(value).callFrames);
  return frames.map((entry) => frameOf(record(entry)));
}

function frameOf(frame: Record<string, unknown>): AgentBrowserStackFrame {
  const url = optionalString(frame.url);
  const line = optionalNumber(frame.lineNumber);
  const column = optionalNumber(frame.columnNumber);
  const functionName = optionalString(frame.functionName);
  return {
    ...(url === undefined ? {} : { url: truncateDebugText(url, MAX_URL_LENGTH) }),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(functionName === undefined
      ? {}
      : {
          functionName: truncateDebugText(
            functionName,
            MAX_FUNCTION_NAME_LENGTH,
          ),
        }),
  };
}

function boundJsonArg(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "unserializable";
  }
  if (serialized === undefined) return { type: "undefined" };
  if (serialized.length <= MAX_DEBUG_TEXT_LENGTH) return value;
  let candidate = truncateDebugText(serialized, MAX_DEBUG_TEXT_LENGTH);
  for (;;) {
    const again = JSON.stringify(candidate);
    if (again.length <= MAX_DEBUG_TEXT_LENGTH) return candidate;
    const overflow = again.length - MAX_DEBUG_TEXT_LENGTH;
    candidate = truncateDebugText(
      candidate,
      Math.max(1, candidate.length - overflow),
    );
  }
}

function firstCallFrame(value: unknown): Record<string, unknown> {
  const frames = list(record(value).callFrames);
  return frames.length === 0 ? {} : record(frames[0]);
}

function initiatorFrame(event: Record<string, unknown>): AgentBrowserStackFrame | undefined {
  const initiator = record(event.initiator);
  const stacked = frameOf(firstCallFrame(initiator.stack));
  if (
    stacked.url !== undefined ||
    stacked.line !== undefined ||
    stacked.column !== undefined
  ) {
    return stacked;
  }
  const url = optionalString(initiator.url);
  if (url === undefined) return undefined;
  return { url: truncateDebugText(url, MAX_URL_LENGTH) };
}

/**
 * Best-effort text for a CDP `RemoteObject`.
 *
 * `Runtime.consoleAPICalled` and `Log.entryAdded` deliver arguments as
 * descriptors, not values. Primitives carry `value`; everything else only
 * carries the `description` Chromium generated for it. Complex objects are
 * therefore rendered as that preview rather than deeply serialized, because a
 * faithful serialization would cost a `Runtime.callFunctionOn` round trip per
 * argument, which is far too expensive for a high-volume event stream.
 */
function remoteObjectText(value: unknown): string {
  const object = record(value);
  const unserializable = object.unserializableValue;
  if (typeof unserializable === "string") return unserializable;
  const primitive = object.value;
  if (
    typeof primitive === "string" ||
    typeof primitive === "number" ||
    typeof primitive === "boolean"
  ) {
    return String(primitive);
  }
  if (primitive === null) return "null";
  const description = optionalString(object.description);
  if (description !== undefined) return description;
  return optionalString(object.subtype) ??
    optionalString(object.type) ??
    "unknown";
}

/**
 * Shallow JSON-serializable projection of a CDP `RemoteObject`. Primitives
 * become JSON values; objects keep type/class/description plus a one-level
 * preview of named properties. Nothing here triggers a CDP round trip.
 */
function shallowRemoteObject(value: unknown): unknown {
  const object = record(value);
  const unserializable = object.unserializableValue;
  if (typeof unserializable === "string") return unserializable;
  if (object.type === "undefined") return { type: "undefined" };
  if (Object.hasOwn(object, "value")) {
    const primitive = object.value;
    if (
      primitive === null ||
      typeof primitive === "string" ||
      typeof primitive === "number" ||
      typeof primitive === "boolean"
    ) {
      return primitive;
    }
  }
  const preview = record(object.preview);
  const properties = list(preview.properties);
  const previewObject: Record<string, unknown> = {};
  for (const property of properties) {
    const item = record(property);
    const name = optionalString(item.name);
    if (name === undefined) continue;
    if (Object.hasOwn(item, "value")) {
      previewObject[name] = item.value;
    } else {
      previewObject[name] = optionalString(item.description) ??
        optionalString(item.type) ??
        "unknown";
    }
  }
  const projected: Record<string, unknown> = {
    type: optionalString(object.type) ?? "object",
  };
  const className = optionalString(object.className);
  const description = optionalString(object.description);
  if (className !== undefined) projected.className = className;
  if (description !== undefined) projected.description = description;
  if (properties.length > 0) projected.preview = previewObject;
  return projected;
}

function consoleLevel(value: unknown): AgentBrowserConsoleLevel {
  switch (value) {
    case "error":
      return "error";
    case "warning":
      return "warn";
    case "info":
      return "info";
    case "debug":
    case "verbose":
      return "debug";
    default:
      return "log";
  }
}

function isFailureStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400;
}

function isDefaultHiddenNetworkResourceType(type: string): boolean {
  return (DEFAULT_HIDDEN_NETWORK_RESOURCE_TYPES as readonly string[])
    .includes(type.toLowerCase());
}

function newestSlice<T>(
  matched: readonly T[],
  limit: number | undefined,
): { readonly items: readonly T[]; readonly truncated: boolean } {
  const take = limit === undefined ||
      !Number.isSafeInteger(limit) ||
      limit <= 0
    ? matched.length
    : Math.min(limit, matched.length);
  const start = matched.length - take;
  return { items: matched.slice(start), truncated: start > 0 };
}

function parseHeaderMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") continue;
    headers[key] = truncateDebugText(entry, MAX_DEBUG_TEXT_LENGTH);
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

export function redactDebugHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = REDACTED_HEADER_NAMES.has(key.toLowerCase())
      ? REDACTED_HEADER_VALUE
      : value;
  }
  return redacted;
}

export function isTextualNetworkBody(mimeType: string | undefined): boolean {
  if (mimeType === undefined || mimeType === "") return false;
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/x-www-form-urlencoded" ||
    mime === "multipart/form-data" ||
    mime.endsWith("+json");
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function isTextualRequestBody(
  headers: Readonly<Record<string, string>> | undefined,
  postData: string | undefined,
): boolean {
  const contentType = headerValue(headers, "content-type");
  if (contentType !== undefined) return isTextualNetworkBody(contentType);
  return postData !== undefined && postData !== "";
}

function isRemoteSourceMapUrl(sourceMapURL: string): boolean {
  const trimmed = sourceMapURL.trim();
  if (trimmed === "" || /^data:/iu.test(trimmed)) return false;
  return true;
}

function resolveRemoteSourceMapUrl(
  scriptUrl: string,
  sourceMapURL: string,
): string | undefined {
  const trimmed = sourceMapURL.trim();
  if (!isRemoteSourceMapUrl(trimmed)) return undefined;
  try {
    return new URL(trimmed, scriptUrl).href;
  } catch {
    return undefined;
  }
}

export function isSameOriginHttpUrl(
  scriptUrl: string,
  sourceMapUrl: string,
): boolean {
  try {
    const script = new URL(scriptUrl);
    const map = new URL(sourceMapUrl, scriptUrl);
    return (
      (map.protocol === "http:" || map.protocol === "https:") &&
      script.origin === map.origin
    );
  } catch {
    return false;
  }
}

function isTerminalOutcome(outcome: AgentBrowserNetworkOutcome): boolean {
  return outcome === "finished" || outcome === "failed";
}

export class AgentBrowserDebugCollector {
  readonly #maxConsoleMessages: number;
  readonly #maxNetworkRequests: number;
  #enabled = false;
  #console: ConsoleEntry[] = [];
  readonly #network = new Map<string, NetworkEntry>();
  readonly #sourceMaps = new Map<string, SourceMapBindings>();
  #pendingSourceMaps: AgentBrowserPendingSourceMap[] = [];
  readonly #networkWaiters: NetworkWaiter[] = [];
  #sequence = 0;

  constructor(options: AgentBrowserDebugCollectorOptions = {}) {
    this.#maxConsoleMessages =
      options.maxConsoleMessages ?? MAX_DEBUG_CONSOLE_MESSAGES;
    this.#maxNetworkRequests =
      options.maxNetworkRequests ?? MAX_DEBUG_NETWORK_REQUESTS;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** High-water id assigned so far, including cleared/dropped entries. */
  get lastId(): number {
    return this.#sequence;
  }

  markEnabled(): void {
    this.#enabled = true;
  }

  /**
   * Stop capture and drop everything buffered.
   *
   * Buffered requests lose their response bodies as soon as the `Network`
   * domain is disabled, so retaining them across a disable would only expose
   * entries whose bodies can no longer be fetched.
   */
  markDisabled(): void {
    this.#enabled = false;
    this.clear("capture disabled");
    this.clearSourceMaps();
    this.#resolveNetworkWaiters();
  }

  /**
   * Drop buffered console and network entries.
   *
   * Callers must only do this at document commit / navigation start, or when
   * the agent passes `clear: true`. Snapshot and post-load reference
   * invalidation must not empty a load that has already been recorded.
   *
   * While capture is enabled a lifecycle marker is appended after clearing so
   * a later read shows which capture window the remaining rows belong to.
   * When capture is off the `enabled: false` view already explains an empty
   * buffer, so no marker is written.
   */
  clear(reason: string = "reset"): void {
    this.#console = [];
    this.#network.clear();
    if (this.#enabled) {
      this.#pushCaptureMarker(`buffer cleared (${reason})`);
    }
    this.#resolveNetworkWaiters();
  }

  /** Drop parsed source maps. Navigation invalidates loaded scripts. */
  clearSourceMaps(): void {
    this.#sourceMaps.clear();
    this.#pendingSourceMaps = [];
  }

  handleEvent(method: string, params: unknown): void {
    if (!this.#enabled) return;
    switch (method) {
      case "Debugger.scriptParsed":
        this.#onScriptParsed(params);
        return;
      case "Runtime.consoleAPICalled":
        this.#onConsoleApiCalled(params);
        return;
      case "Runtime.exceptionThrown":
        this.#onExceptionThrown(params);
        return;
      case "Log.entryAdded":
        this.#onLogEntryAdded(params);
        return;
      case "Network.requestWillBeSent":
        this.#onRequestWillBeSent(params);
        return;
      case "Network.responseReceived":
        this.#onResponseReceived(params);
        return;
      case "Network.loadingFinished":
        this.#onLoadingFinished(params);
        return;
      case "Network.loadingFailed":
        this.#onLoadingFailed(params);
        return;
      default:
        return;
    }
  }

  readConsole(
    query: AgentBrowserConsoleQuery = {},
  ): AgentBrowserConsoleView {
    if (query.id !== undefined) {
      const entry = this.#console.find((message) => message.id === query.id);
      return {
        enabled: this.#enabled,
        messages: entry === undefined
          ? []
          : [this.#presentConsole(entry, true)],
        truncated: false,
        totalCount: entry === undefined ? 0 : 1,
        lastId: this.#sequence,
      };
    }
    const levels = query.levels === undefined || query.levels.length === 0
      ? undefined
      : new Set<string>(query.levels);
    const matched = this.#console.filter((message) => {
      if (query.sinceId !== undefined && message.id <= query.sinceId) {
        return false;
      }
      return levels === undefined || levels.has(message.level);
    });
    const sliced = newestSlice(matched, query.limit);
    return {
      enabled: this.#enabled,
      messages: sliced.items.map((entry) => this.#presentConsole(entry, false)),
      truncated: sliced.truncated,
      totalCount: matched.length,
      lastId: this.#sequence,
    };
  }

  readNetwork(
    query: AgentBrowserNetworkQuery = {},
  ): AgentBrowserNetworkView {
    if (query.id !== undefined) {
      const entry = [...this.#network.values()].find(
        (request) => request.id === query.id,
      );
      return {
        enabled: this.#enabled,
        requests: entry === undefined ? [] : [toRequest(entry, true)],
        truncated: false,
        totalCount: entry === undefined ? 0 : 1,
        lastId: this.#sequence,
      };
    }
    const matched = this.#matchingNetwork(query);
    const sliced = newestSlice(matched, query.limit);
    return {
      enabled: this.#enabled,
      requests: sliced.items.map((entry) => toRequest(entry, false)),
      truncated: sliced.truncated,
      totalCount: matched.length,
      lastId: this.#sequence,
    };
  }

  /**
   * Resolve when a matching request newer than `sinceId` (default: current
   * high-water) reaches finished or failed. The caller owns timeouts.
   */
  waitForNetwork(
    query: AgentBrowserNetworkQuery = {},
  ): {
    readonly promise: Promise<AgentBrowserNetworkView>;
    readonly cancel: () => void;
  } {
    const sinceId = query.sinceId ?? this.#sequence;
    const waitQuery = { ...query, sinceId };
    const current = this.#terminalNetworkView(waitQuery);
    if (current !== undefined) {
      return {
        promise: Promise.resolve(current),
        cancel: () => {},
      };
    }
    let resolve!: (view: AgentBrowserNetworkView) => void;
    const promise = new Promise<AgentBrowserNetworkView>((done) => {
      resolve = done;
    });
    const waiter: NetworkWaiter = { query: waitQuery, resolve };
    this.#networkWaiters.push(waiter);
    return {
      promise,
      cancel: () => {
        const index = this.#networkWaiters.indexOf(waiter);
        if (index >= 0) this.#networkWaiters.splice(index, 1);
      },
    };
  }

  takePendingRemoteSourceMaps(): readonly AgentBrowserPendingSourceMap[] {
    const pending = this.#pendingSourceMaps;
    this.#pendingSourceMaps = [];
    return pending;
  }

  ingestSourceMap(scriptUrl: string, value: unknown): boolean {
    const parsed = parseSourceMap(value);
    if (parsed === undefined) return false;
    this.#sourceMaps.set(scriptUrl, parsed);
    return true;
  }

  networkRequestIdFor(id: number): string | undefined {
    for (const [requestId, entry] of this.#network) {
      if (entry.id === id) return requestId;
    }
    return undefined;
  }

  networkMimeTypeFor(id: number): string | undefined {
    for (const entry of this.#network.values()) {
      if (entry.id === id) return entry.mimeType;
    }
    return undefined;
  }

  attachResponseBody(cdpRequestId: string, body: string): void {
    const existing = this.#network.get(cdpRequestId);
    if (existing === undefined) return;
    if (!isTextualNetworkBody(existing.mimeType)) return;
    this.#network.set(cdpRequestId, {
      ...existing,
      body: truncateDebugText(body, MAX_DEBUG_TEXT_LENGTH),
    });
  }

  needsRequestPostData(id: number): boolean {
    for (const entry of this.#network.values()) {
      if (entry.id === id) return entry.needsPostData === true;
    }
    return false;
  }

  attachRequestBody(cdpRequestId: string, body: string): void {
    const existing = this.#network.get(cdpRequestId);
    if (existing === undefined) return;
    if (!isTextualRequestBody(existing.requestHeaders, body)) return;
    this.#network.set(cdpRequestId, {
      ...existing,
      requestBody: truncateDebugText(body, MAX_DEBUG_TEXT_LENGTH),
      needsPostData: false,
    });
  }

  #matchingNetwork(query: AgentBrowserNetworkQuery): NetworkEntry[] {
    const types = query.resourceTypes === undefined ||
        query.resourceTypes.length === 0
      ? undefined
      : new Set<string>(query.resourceTypes);
    return [...this.#network.values()].filter((entry) => {
      if (query.sinceId !== undefined && entry.id <= query.sinceId) {
        return false;
      }
      if (
        query.urlContains !== undefined &&
        query.urlContains !== "" &&
        !entry.url.includes(query.urlContains)
      ) {
        return false;
      }
      if (types === undefined) {
        if (isDefaultHiddenNetworkResourceType(entry.resourceType)) {
          return false;
        }
      } else if (!types.has(entry.resourceType)) {
        return false;
      }
      if (query.failuresOnly === true) {
        return entry.outcome === "failed" ||
          isFailureStatus(entry.status);
      }
      return true;
    });
  }

  #terminalNetworkView(
    query: AgentBrowserNetworkQuery,
  ): AgentBrowserNetworkView | undefined {
    const view = this.readNetwork(query);
    if (
      view.requests.some((request) => isTerminalOutcome(request.outcome))
    ) {
      return view;
    }
    return undefined;
  }

  #resolveNetworkWaiters(): void {
    if (this.#networkWaiters.length === 0) return;
    const pending = this.#networkWaiters.splice(0);
    for (const waiter of pending) {
      const view = this.#terminalNetworkView(waiter.query);
      if (view === undefined) {
        this.#networkWaiters.push(waiter);
      } else {
        waiter.resolve(view);
      }
    }
  }

  #nextId(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  /**
   * Capture-lifecycle marker rendered as a `browser` console row so reads
   * are self-describing: the agent can tell whether capture was enabled,
   * cleared, or reset without guessing from empty buffers.
   */
  #pushCaptureMarker(text: string): void {
    this.#pushConsole("info", "browser", `[agent-browser capture] ${text}`, []);
  }

  #presentConsole(
    entry: ConsoleEntry,
    detail: boolean,
  ): AgentBrowserConsoleMessage {
    const stack = entry.frames.map((frame) => this.#remap(frame));
    const first = stack[0] ?? {};
    return {
      id: entry.id,
      level: entry.level,
      source: entry.source,
      text: entry.text,
      timestamp: entry.timestamp,
      ...(first.url === undefined ? {} : { url: first.url }),
      ...(first.line === undefined ? {} : { line: first.line }),
      ...(first.column === undefined ? {} : { column: first.column }),
      ...(detail ? { args: entry.args, stack } : {}),
    };
  }

  #pushConsole(
    level: AgentBrowserConsoleLevel,
    source: AgentBrowserConsoleSource,
    text: string,
    frames: readonly AgentBrowserStackFrame[],
    args: readonly unknown[] = [],
  ): void {
    this.#console.push({
      id: this.#nextId(),
      level,
      source,
      text: truncateDebugText(text, MAX_DEBUG_TEXT_LENGTH),
      timestamp: Date.now(),
      frames,
      args,
    });
    if (this.#console.length > this.#maxConsoleMessages) {
      this.#console.splice(
        0,
        this.#console.length - this.#maxConsoleMessages,
      );
    }
  }

  #onScriptParsed(params: unknown): void {
    const event = record(params);
    const url = optionalString(event.url);
    const sourceMapURL = optionalString(event.sourceMapURL);
    if (url === undefined || sourceMapURL === undefined) return;
    const inline = decodeDataSourceMap(sourceMapURL);
    if (inline !== undefined) {
      const parsed = parseSourceMap(inline);
      if (parsed !== undefined) this.#sourceMaps.set(url, parsed);
      return;
    }
    const resolved = resolveRemoteSourceMapUrl(url, sourceMapURL);
    if (resolved === undefined) return;
    this.#pendingSourceMaps.push({
      scriptUrl: url,
      sourceMapUrl: resolved,
    });
  }

  #remap(location: Location): Location {
    if (
      location.url === undefined ||
      location.line === undefined ||
      location.column === undefined
    ) {
      return location;
    }
    const mapped = remapGeneratedPosition(
      this.#sourceMaps.get(location.url),
      location.line,
      location.column,
    );
    if (mapped === undefined) return location;
    return {
      ...mapped,
      ...(mapped.url === undefined
        ? {}
        : { url: truncateDebugText(mapped.url, MAX_URL_LENGTH) }),
      ...(location.functionName === undefined
        ? {}
        : { functionName: location.functionName }),
    };
  }

  #onConsoleApiCalled(params: unknown): void {
    const event = record(params);
    const args = list(event.args);
    const text = args.map(remoteObjectText).join(" ");
    this.#pushConsole(
      consoleLevel(event.type),
      "console",
      text,
      callFramesOf(event.stackTrace),
      args.map((entry) => boundJsonArg(shallowRemoteObject(entry))),
    );
  }

  #onExceptionThrown(params: unknown): void {
    const details = record(record(params).exceptionDetails);
    const exception = record(details.exception);
    const text = optionalString(exception.description) ??
      optionalString(details.text) ??
      "Uncaught exception";
    this.#pushConsole(
      "error",
      "exception",
      text,
      callFramesOf(details.stackTrace),
      details.exception === undefined
        ? []
        : [boundJsonArg(shallowRemoteObject(details.exception))],
    );
  }

  #onLogEntryAdded(params: unknown): void {
    const entry = record(record(params).entry);
    this.#pushConsole(
      consoleLevel(entry.level),
      "browser",
      optionalString(entry.text) ?? "",
      [frameOf(entry)],
    );
  }

  #onRequestWillBeSent(params: unknown): void {
    const event = record(params);
    const requestId = optionalString(event.requestId);
    if (requestId === undefined) return;
    const request = record(event.request);
    const startedAt = optionalNumber(event.timestamp);
    const headers = parseHeaderMap(request.headers);
    const initiator = initiatorFrame(event);
    const postData = optionalString(request.postData);
    const hasPostData = request.hasPostData === true;
    const requestBody = postData !== undefined &&
        isTextualRequestBody(headers, postData)
      ? truncateDebugText(postData, MAX_DEBUG_TEXT_LENGTH)
      : undefined;
    this.#network.set(requestId, {
      id: this.#nextId(),
      cdpRequestId: requestId,
      method: truncateDebugText(
        optionalString(request.method) ?? "GET",
        MAX_NETWORK_METHOD_LENGTH,
      ),
      url: truncateDebugText(optionalString(request.url) ?? "", MAX_URL_LENGTH),
      resourceType: truncateDebugText(
        optionalString(event.type) ?? "other",
        MAX_RESOURCE_TYPE_LENGTH,
      ),
      wallClock: Date.now(),
      ...(startedAt === undefined ? {} : { startedAt }),
      outcome: "pending",
      ...(headers === undefined ? {} : { requestHeaders: headers }),
      ...(initiator === undefined ? {} : { initiator }),
      ...(requestBody === undefined ? {} : { requestBody }),
      ...(hasPostData && requestBody === undefined
        ? { needsPostData: true }
        : {}),
    });
    this.#trimNetwork();
  }

  #onResponseReceived(params: unknown): void {
    const event = record(params);
    const requestId = optionalString(event.requestId);
    if (requestId === undefined) return;
    const existing = this.#network.get(requestId);
    if (existing === undefined) return;
    const response = record(event.response);
    const status = optionalNumber(response.status);
    const statusText = optionalString(response.statusText);
    const mimeType = optionalString(response.mimeType);
    const size = optionalNumber(response.encodedDataLength);
    const headers = parseHeaderMap(response.headers);
    this.#network.set(requestId, {
      ...existing,
      ...(status === undefined ? {} : { status }),
      ...(statusText === undefined ? {} : { statusText }),
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(size === undefined ? {} : { encodedDataLength: size }),
      ...(headers === undefined ? {} : { responseHeaders: headers }),
    });
  }

  #onLoadingFinished(params: unknown): void {
    const event = record(params);
    const requestId = optionalString(event.requestId);
    if (requestId === undefined) return;
    const existing = this.#network.get(requestId);
    if (existing === undefined) return;
    const size = optionalNumber(event.encodedDataLength);
    const finishedAt = optionalNumber(event.timestamp);
    const durationMs = existing.startedAt === undefined ||
        finishedAt === undefined
      ? undefined
      : Math.max(0, Math.round((finishedAt - existing.startedAt) * 1000));
    this.#network.set(requestId, {
      ...existing,
      outcome: "finished",
      ...(size === undefined ? {} : { encodedDataLength: size }),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    this.#resolveNetworkWaiters();
  }

  #onLoadingFailed(params: unknown): void {
    const event = record(params);
    const requestId = optionalString(event.requestId);
    if (requestId === undefined) return;
    const existing = this.#network.get(requestId);
    if (existing === undefined) return;
    const errorText = optionalString(event.errorText);
    const blockedReason = optionalString(event.blockedReason);
    this.#network.set(requestId, {
      ...existing,
      outcome: "failed",
      ...(errorText === undefined ? {} : { errorText }),
      ...(blockedReason === undefined
        ? {}
        : {
            blockedReason: truncateDebugText(
              blockedReason,
              MAX_BLOCKED_REASON_LENGTH,
            ),
          }),
    });
    this.#resolveNetworkWaiters();
  }

  #trimNetwork(): void {
    while (this.#network.size > this.#maxNetworkRequests) {
      const oldest = this.#network.keys().next();
      if (oldest.done === true) return;
      this.#network.delete(oldest.value);
    }
  }
}

const VLQ_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeDataSourceMap(sourceMapURL: string): unknown {
  const match = /^data:application\/json(?:;[^,]*)?;base64,(.+)$/iu
    .exec(sourceMapURL.trim());
  if (match === null || match[1] === undefined) return undefined;
  try {
    return JSON.parse(
      Buffer.from(match[1], "base64").toString("utf8"),
    );
  } catch {
    return undefined;
  }
}

function decodeVlqValues(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = VLQ_ALPHABET.indexOf(char);
    if (digit < 0) return values;
    const continued = (digit & 32) !== 0;
    value += (digit & 31) << shift;
    if (continued) {
      shift += 5;
      continue;
    }
    const signed = (value & 1) === 1 ? -(value >> 1) : value >> 1;
    values.push(signed);
    value = 0;
    shift = 0;
  }
  return values;
}

function parseSourceMap(value: unknown): SourceMapBindings | undefined {
  const map = record(value);
  if (map.version !== 3 || typeof map.mappings !== "string") {
    return undefined;
  }
  const sources = list(map.sources).filter(
    (entry): entry is string =>
      typeof entry === "string" && entry !== "",
  );
  if (sources.length === 0) return undefined;
  const sourceRoot = typeof map.sourceRoot === "string"
    ? map.sourceRoot
    : "";
  const resolvedSources = sources.map((source) => {
    if (
      sourceRoot === "" ||
      /^[a-z][a-z0-9+.-]*:/iu.test(source) ||
      source.startsWith("/")
    ) {
      return source;
    }
    return sourceRoot.endsWith("/")
      ? `${sourceRoot}${source}`
      : `${sourceRoot}/${source}`;
  });
  const lines: SourceMapSegment[][] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  for (const lineText of map.mappings.split(";")) {
    const segments: SourceMapSegment[] = [];
    let generatedColumn = 0;
    if (lineText !== "") {
      for (const raw of lineText.split(",")) {
        const values = decodeVlqValues(raw);
        if (values.length === 0) continue;
        generatedColumn += values[0] ?? 0;
        if (values.length >= 4) {
          sourceIndex += values[1] ?? 0;
          originalLine += values[2] ?? 0;
          originalColumn += values[3] ?? 0;
          if (
            sourceIndex >= 0 &&
            sourceIndex < resolvedSources.length &&
            originalLine >= 0 &&
            originalColumn >= 0
          ) {
            segments.push({
              generatedColumn,
              sourceIndex,
              originalLine,
              originalColumn,
            });
          }
        }
      }
    }
    lines.push(segments);
  }
  return { sources: resolvedSources, lines };
}

function remapGeneratedPosition(
  bindings: SourceMapBindings | undefined,
  generatedLine: number,
  generatedColumn: number,
): Location | undefined {
  if (bindings === undefined || generatedLine < 0) return undefined;
  const segments = bindings.lines[generatedLine];
  if (segments === undefined || segments.length === 0) return undefined;
  let chosen: SourceMapSegment | undefined;
  for (const segment of segments) {
    if (segment.generatedColumn > generatedColumn) break;
    chosen = segment;
  }
  if (chosen === undefined) return undefined;
  const url = bindings.sources[chosen.sourceIndex];
  if (url === undefined) return undefined;
  return {
    url,
    line: chosen.originalLine,
    column: chosen.originalColumn,
  };
}

function toRequest(
  entry: NetworkEntry,
  detail: boolean,
): AgentBrowserNetworkRequest {
  const requestHeaders = detail
    ? redactDebugHeaders(entry.requestHeaders)
    : undefined;
  const responseHeaders = detail
    ? redactDebugHeaders(entry.responseHeaders)
    : undefined;
  return {
    id: entry.id,
    method: entry.method,
    url: entry.url,
    resourceType: entry.resourceType,
    outcome: entry.outcome,
    timestamp: entry.wallClock,
    ...(entry.status === undefined ? {} : { status: entry.status }),
    ...(entry.statusText === undefined
      ? {}
      : { statusText: entry.statusText }),
    ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
    ...(entry.encodedDataLength === undefined
      ? {}
      : { encodedDataLength: entry.encodedDataLength }),
    ...(entry.durationMs === undefined
      ? {}
      : { durationMs: entry.durationMs }),
    ...(entry.errorText === undefined
      ? {}
      : { errorText: entry.errorText }),
    ...(requestHeaders === undefined ? {} : { requestHeaders }),
    ...(responseHeaders === undefined ? {} : { responseHeaders }),
    ...(detail && entry.requestBody !== undefined
      ? { requestBody: entry.requestBody }
      : {}),
    ...(detail && entry.body !== undefined ? { body: entry.body } : {}),
    ...(detail && entry.initiator !== undefined
      ? { initiator: entry.initiator }
      : {}),
    ...(detail && entry.blockedReason !== undefined
      ? { blockedReason: entry.blockedReason }
      : {}),
  };
}
