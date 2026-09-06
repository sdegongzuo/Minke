export const BROWSER_SETTINGS_READ_CHANNEL =
  "minke:browser-settings:read";
export const BROWSER_SETTINGS_WRITE_CHANNEL =
  "minke:browser-settings:write";

export const BROWSER_USER_AGENT_MAX_LENGTH = 512;

/** Harness child env: `"1"` exposes Agent Browser debug tools. */
export const MINKE_AGENT_BROWSER_DEBUG_ENABLED_ENV =
  "MINKE_AGENT_BROWSER_DEBUG_ENABLED";

export interface BrowserSettings {
  /**
   * Empty means: derive a reduced Chrome UA from the embedded Chromium
   * runtime, without Minke or Electron product tokens.
   */
  webUserAgent: string;
  agentUserAgent: string;
  /**
   * When false (the default), Agent Browser debug tools stay hidden from
   * the agent catalog. Existing documents omit this key; parse treats that
   * as false.
   */
  agentDebug: boolean;
}

export const DEFAULT_BROWSER_SETTINGS: Readonly<BrowserSettings> =
  Object.freeze({
    webUserAgent: "",
    agentUserAgent: "",
    agentDebug: false,
  });

const USER_AGENT_PRODUCT_TOKEN =
  /(?:^|\s+)(?:Minke|Electron)\/[^\s]+/giu;
const CHROME_VERSION_TOKEN =
  /\bChrome\/(\d+)(?:\.\d+){3}\b/u;
const VISIBLE_ASCII = /^[\x20-\x7e]*$/u;

function parseUserAgentField(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`invalid ${label} user agent`);
  }
  if (
    value.length > BROWSER_USER_AGENT_MAX_LENGTH ||
    !VISIBLE_ASCII.test(value)
  ) {
    throw new TypeError(`invalid ${label} user agent`);
  }
  const normalized = value.trim();
  return normalized;
}

/** Convert Electron's real platform UA into its reduced Chrome equivalent. */
export function defaultChromeUserAgent(source: string): string {
  const normalized = parseUserAgentField(source, "source")
    .replace(USER_AGENT_PRODUCT_TOKEN, "")
    .replace(/\s{2,}/gu, " ")
    .replace(CHROME_VERSION_TOKEN, "Chrome/$1.0.0.0")
    .trim();
  if (
    normalized === "" ||
    !/\bChrome\/\d+\.0\.0\.0\b/u.test(normalized)
  ) {
    throw new TypeError("source user agent is not Chromium-based");
  }
  return normalized;
}

/** Resolve an optional custom value against Minke's automatic Chrome UA. */
export function resolveBrowserUserAgent(
  configured: string,
  source: string,
): string {
  const custom = parseUserAgentField(configured, "custom");
  return custom === "" ? defaultChromeUserAgent(source) : custom;
}

/** Validate and normalize both independently configurable UA values. */
export function parseBrowserSettings(value: unknown): BrowserSettings {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError("invalid browser settings");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    !Object.hasOwn(record, "webUserAgent") ||
    !Object.hasOwn(record, "agentUserAgent") ||
    keys.some(
      (key) =>
        key !== "webUserAgent" &&
        key !== "agentUserAgent" &&
        key !== "agentDebug",
    )
  ) {
    throw new TypeError("invalid browser settings");
  }
  const agentDebug = record.agentDebug === undefined
    ? false
    : record.agentDebug;
  if (typeof agentDebug !== "boolean") {
    throw new TypeError("invalid browser settings");
  }
  return {
    webUserAgent: parseUserAgentField(
      record.webUserAgent,
      "web",
    ),
    agentUserAgent: parseUserAgentField(
      record.agentUserAgent,
      "agent",
    ),
    agentDebug,
  };
}
