import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentBrowserDebugCollector,
  DEBUG_TRUNCATION_SUFFIX,
  DEFAULT_HIDDEN_NETWORK_RESOURCE_TYPES,
  MAX_DEBUG_NETWORK_REQUESTS,
  MAX_DEBUG_TEXT_LENGTH,
  REDACTED_HEADER_VALUE,
} from "@minke/desktop/main/agent-browser/debug.ts";
import {
  MAX_AGENT_BROWSER_DEBUG_LIMIT,
  agentBrowserSuccessResponse,
  parseAgentBrowserOperationResult,
} from "@minke/harness-overlay/agent-browser-contract.ts";

function sessionEnvelope(view) {
  return {
    sessionId: "browser-1",
    generation: 1,
    owner: "agent",
    status: "ready",
    snapshotRequired: false,
    ...view,
  };
}

function collector(options = {}) {
  const debug = new AgentBrowserDebugCollector(options);
  debug.markEnabled();
  return debug;
}

function consoleApi(type, text, location = {}) {
  return {
    type,
    args: [{ type: "string", value: text }],
    stackTrace: {
      callFrames: [{
        url: location.url ?? "https://app.local/main.ts",
        lineNumber: location.line ?? 12,
        columnNumber: location.column ?? 4,
      }],
    },
  };
}

function sendRequest(debug, {
  requestId,
  method = "GET",
  url,
  type,
  status,
  statusText = "OK",
  timestamp = 1,
  finishAt = 1.042,
  failed,
  errorText,
}) {
  debug.handleEvent("Network.requestWillBeSent", {
    requestId,
    type,
    timestamp,
    request: { method, url },
  });
  if (failed === true) {
    debug.handleEvent("Network.loadingFailed", {
      requestId,
      errorText: errorText ?? "net::ERR_FAILED",
    });
    return;
  }
  if (status !== undefined) {
    debug.handleEvent("Network.responseReceived", {
      requestId,
      response: {
        status,
        statusText,
        mimeType: "application/json",
        encodedDataLength: 128,
      },
    });
    debug.handleEvent("Network.loadingFinished", {
      requestId,
      encodedDataLength: 128,
      timestamp: finishAt,
    });
  }
}

test("debug collector ignores events until capture is enabled", () => {
  const debug = new AgentBrowserDebugCollector();
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("error", "too early"));
  debug.handleEvent("Network.requestWillBeSent", {
    requestId: "r0",
    type: "XHR",
    request: { method: "GET", url: "https://api.local/early" },
  });
  assert.equal(debug.enabled, false);
  assert.deepEqual(debug.readConsole().messages, []);
  assert.deepEqual(debug.readNetwork().requests, []);

  debug.markEnabled();
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("log", "after enable"));
  assert.equal(debug.readConsole().messages.length, 1);
  assert.equal(debug.readConsole().messages[0].text, "after enable");
});

test("debug collector classifies console, exception, and browser log events", () => {
  const debug = collector();
  debug.handleEvent(
    "Runtime.consoleAPICalled",
    consoleApi("error", "boom"),
  );
  debug.handleEvent("Runtime.exceptionThrown", {
    exceptionDetails: {
      text: "Uncaught",
      exception: { description: "TypeError: x is not a function" },
      stackTrace: {
        callFrames: [{
          url: "https://app.local/store.ts",
          lineNumber: 8,
          columnNumber: 1,
        }],
      },
    },
  });
  debug.handleEvent("Log.entryAdded", {
    entry: {
      level: "warning",
      text: "Refused to load script",
      url: "https://app.local/",
      lineNumber: 1,
      columnNumber: 0,
    },
  });

  const view = debug.readConsole();
  assert.equal(view.enabled, true);
  assert.equal(view.messages.length, 3);
  assert.equal(view.messages[0].level, "error");
  assert.equal(view.messages[0].source, "console");
  assert.equal(view.messages[0].text, "boom");
  assert.equal(view.messages[0].url, "https://app.local/main.ts");
  assert.equal(view.messages[0].line, 12);
  assert.equal(view.messages[0].column, 4);
  assert.equal(view.messages[1].source, "exception");
  assert.equal(view.messages[1].text, "TypeError: x is not a function");
  assert.equal(view.messages[2].level, "warn");
  assert.equal(view.messages[2].source, "browser");
  assert.equal(view.messages[2].text, "Refused to load script");
});

test("debug collector level filter and newest-last cap", () => {
  const debug = collector({ maxConsoleMessages: 3 });
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("log", "one"));
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("warn", "two"));
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("error", "three"));
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("error", "four"));

  const all = debug.readConsole();
  assert.deepEqual(
    all.messages.map((message) => message.text),
    ["two", "three", "four"],
  );
  assert.equal(all.totalCount, 3);

  const errors = debug.readConsole({ levels: ["error"] });
  assert.deepEqual(
    errors.messages.map((message) => message.text),
    ["three", "four"],
  );
  const limited = debug.readConsole({ limit: 1 });
  assert.deepEqual(
    limited.messages.map((message) => message.text),
    ["four"],
  );
  assert.equal(limited.truncated, true);
  assert.equal(limited.totalCount, 3);
});

test("debug collector joins network request lifecycle and failures-only", () => {
  const debug = collector();
  sendRequest(debug, {
    requestId: "ok",
    url: "https://api.local/users",
    type: "XHR",
    status: 200,
  });
  sendRequest(debug, {
    requestId: "http-fail",
    url: "https://api.local/missing",
    type: "Fetch",
    status: 404,
    statusText: "Not Found",
  });
  sendRequest(debug, {
    requestId: "net-fail",
    url: "https://api.local/down",
    type: "Fetch",
    failed: true,
    errorText: "net::ERR_CONNECTION_REFUSED",
  });
  sendRequest(debug, {
    requestId: "pending",
    url: "https://api.local/slow",
    type: "XHR",
  });

  const view = debug.readNetwork();
  assert.equal(view.requests.length, 4);
  const [ok, httpFail, netFail, pending] = view.requests;
  assert.equal(ok.outcome, "finished");
  assert.equal(ok.status, 200);
  assert.equal(ok.durationMs, 42);
  assert.equal(httpFail.status, 404);
  assert.equal(netFail.outcome, "failed");
  assert.equal(netFail.errorText, "net::ERR_CONNECTION_REFUSED");
  assert.equal(pending.outcome, "pending");

  const failures = debug.readNetwork({ failuresOnly: true });
  assert.deepEqual(
    failures.requests.map((request) => request.url),
    ["https://api.local/missing", "https://api.local/down"],
  );
});

test("default network view hides Script/Stylesheet unless those types are requested", () => {
  const debug = collector();
  sendRequest(debug, {
    requestId: "doc",
    url: "https://app.local/",
    type: "Document",
    status: 200,
    statusText: "OK",
  });
  sendRequest(debug, {
    requestId: "api",
    url: "https://app.local/api",
    type: "XHR",
    status: 200,
  });
  sendRequest(debug, {
    requestId: "fetch",
    url: "https://app.local/data",
    type: "Fetch",
    status: 200,
  });
  sendRequest(debug, {
    requestId: "mod",
    url: "https://app.local/src/main.ts",
    type: "Script",
    status: 200,
  });
  sendRequest(debug, {
    requestId: "css",
    url: "https://app.local/src/app.css",
    type: "Stylesheet",
    status: 200,
  });

  const view = debug.readNetwork();
  assert.deepEqual(
    view.requests.map((request) => request.resourceType),
    ["Document", "XHR", "Fetch"],
  );
  assert.equal(
    view.requests.some((request) =>
      DEFAULT_HIDDEN_NETWORK_RESOURCE_TYPES.includes(
        request.resourceType.toLowerCase(),
      )
    ),
    false,
  );

  const scripts = debug.readNetwork({ resourceTypes: ["Script"] });
  assert.deepEqual(
    scripts.requests.map((request) => request.url),
    ["https://app.local/src/main.ts"],
  );
  const sheets = debug.readNetwork({ resourceTypes: ["Stylesheet"] });
  assert.deepEqual(
    sheets.requests.map((request) => request.url),
    ["https://app.local/src/app.css"],
  );
});

test("debug collector disable drops events and clear empties buffers", () => {
  const debug = collector();
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("error", "stale"));
  sendRequest(debug, {
    requestId: "stale",
    url: "https://api.local/stale",
    type: "XHR",
    status: 200,
  });
  debug.markDisabled();
  assert.equal(debug.enabled, false);
  // Disabling while off leaves no marker: the enabled:false view already
  // explains an empty buffer.
  assert.deepEqual(debug.readConsole().messages, []);
  assert.deepEqual(debug.readNetwork().requests, []);

  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("error", "while off"));
  sendRequest(debug, {
    requestId: "off",
    url: "https://api.local/off",
    type: "XHR",
    status: 500,
  });
  assert.deepEqual(debug.readConsole().messages, []);
  assert.deepEqual(debug.readNetwork().requests, []);

  debug.markEnabled();
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("log", "fresh"));
  sendRequest(debug, {
    requestId: "fresh",
    url: "https://api.local/fresh",
    type: "Fetch",
    status: 201,
  });
  debug.clear();
  assert.equal(debug.enabled, true);
  assert.equal(debug.readConsole().messages.length, 1);
  assert.deepEqual(debug.readNetwork().requests, []);
});

test("long console text stays within the contract cap and round-trips through the process result parser", () => {
  const debug = collector();
  const original = "E".repeat(MAX_DEBUG_TEXT_LENGTH + 80);
  debug.handleEvent(
    "Runtime.consoleAPICalled",
    consoleApi("error", original),
  );
  const view = debug.readConsole();
  const text = view.messages[0].text;
  assert.equal(text.length, MAX_DEBUG_TEXT_LENGTH);
  assert.notEqual(text, original);
  assert.equal(text.endsWith(DEBUG_TRUNCATION_SUFFIX), true);

  const parsed = parseAgentBrowserOperationResult(
    "console",
    sessionEnvelope(view),
  );
  assert.equal(parsed.messages[0].text, text);
  assert.doesNotThrow(() =>
    agentBrowserSuccessResponse(1, "console", sessionEnvelope(view))
  );
});

test("a full network buffer round-trips through parseAgentBrowserOperationResult", () => {
  assert.equal(
    MAX_DEBUG_NETWORK_REQUESTS,
    MAX_AGENT_BROWSER_DEBUG_LIMIT,
  );
  const debug = collector();
  for (let index = 0; index < MAX_DEBUG_NETWORK_REQUESTS + 12; index += 1) {
    sendRequest(debug, {
      requestId: `mod-${String(index)}`,
      url: `https://app.local/src/mod-${String(index)}.js`,
      type: "Script",
      status: 200,
    });
  }
  const view = debug.readNetwork({
    resourceTypes: ["Script"],
    limit: 50,
  });
  assert.equal(view.requests.length, 50);
  assert.equal(view.totalCount, MAX_DEBUG_NETWORK_REQUESTS);
  assert.equal(view.truncated, true);

  const parsed = parseAgentBrowserOperationResult(
    "network",
    sessionEnvelope(view),
  );
  assert.equal(parsed.totalCount, MAX_DEBUG_NETWORK_REQUESTS);
  assert.equal(parsed.requests.length, 50);
  assert.doesNotThrow(() =>
    agentBrowserSuccessResponse(1, "network", sessionEnvelope(view))
  );
});

test("explicit clear empties buffers without disabling capture", () => {
  const debug = collector();
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("error", "stale"));
  sendRequest(debug, {
    requestId: "stale",
    url: "https://api.local/stale",
    type: "XHR",
    status: 200,
  });
  debug.clear();
  assert.equal(debug.enabled, true);
  assert.equal(debug.readConsole().messages.length, 1);
  assert.deepEqual(debug.readNetwork().requests, []);
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("log", "fresh"));
  sendRequest(debug, {
    requestId: "fresh",
    url: "https://api.local/fresh",
    type: "Fetch",
    status: 201,
  });
  assert.equal(debug.readConsole().messages.at(-1).text, "fresh");
  assert.equal(debug.readNetwork().requests[0].url, "https://api.local/fresh");
});

function encodeVlq(value) {
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let encoded = "";
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    encoded += alphabet[digit];
  } while (vlq > 0);
  return encoded;
}

test("console locations remap through an injected source map and keep unmapped frames", () => {
  const debug = collector();
  const originalUrl = "https://app.local/src/app.ts";
  const generatedUrl = "https://app.local/bundle.js";
  const map = {
    version: 3,
    file: "bundle.js",
    sources: [originalUrl],
    mappings:
      encodeVlq(42) + encodeVlq(0) + encodeVlq(10) + encodeVlq(4),
  };
  debug.handleEvent("Debugger.scriptParsed", {
    url: generatedUrl,
    sourceMapURL:
      "data:application/json;base64," +
      Buffer.from(JSON.stringify(map), "utf8").toString("base64"),
  });
  debug.handleEvent("Runtime.consoleAPICalled", {
    type: "error",
    args: [{ type: "string", value: "mapped" }],
    stackTrace: {
      callFrames: [{
        url: generatedUrl,
        lineNumber: 0,
        columnNumber: 42,
      }],
    },
  });
  debug.handleEvent("Runtime.consoleAPICalled", {
    type: "warn",
    args: [{ type: "string", value: "plain" }],
    stackTrace: {
      callFrames: [{
        url: "https://app.local/vendor.js",
        lineNumber: 3,
        columnNumber: 1,
      }],
    },
  });
  const view = debug.readConsole();
  assert.equal(view.messages[0].text, "mapped");
  assert.equal(view.messages[0].url, originalUrl);
  assert.equal(view.messages[0].line, 10);
  assert.equal(view.messages[0].column, 4);
  assert.equal(view.messages[1].text, "plain");
  assert.equal(view.messages[1].url, "https://app.local/vendor.js");
  assert.equal(view.messages[1].line, 3);
  assert.equal(view.messages[1].column, 1);
});

test("console id drill-down exposes object args and remaps a multi-frame HTTP source map stack", () => {
  const debug = collector();
  const originalUrl = "https://app.local/src/app.ts";
  const generatedUrl = "https://app.local/bundle.js";
  const mapUrl = "https://app.local/bundle.js.map";
  const map = {
    version: 3,
    sources: [originalUrl],
    mappings:
      encodeVlq(42) + encodeVlq(0) + encodeVlq(10) + encodeVlq(4),
  };
  debug.handleEvent("Debugger.scriptParsed", {
    url: generatedUrl,
    sourceMapURL: mapUrl,
  });
  const pending = debug.takePendingRemoteSourceMaps();
  assert.deepEqual(pending, [{
    scriptUrl: generatedUrl,
    sourceMapUrl: mapUrl,
  }]);
  assert.equal(debug.ingestSourceMap(generatedUrl, map), true);
  debug.handleEvent("Runtime.consoleAPICalled", {
    type: "error",
    args: [
      { type: "string", value: "mapped" },
      {
        type: "object",
        className: "Object",
        description: "Object",
        preview: {
          properties: [{ name: "n", type: "number", value: 1 }],
        },
      },
    ],
    stackTrace: {
      callFrames: [
        {
          functionName: "fail",
          url: generatedUrl,
          lineNumber: 0,
          columnNumber: 42,
        },
        {
          functionName: "boot",
          url: "https://app.local/vendor.js",
          lineNumber: 3,
          columnNumber: 1,
        },
      ],
    },
  });
  const listed = debug.readConsole();
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.lastId, listed.messages[0].id);
  assert.equal(Object.hasOwn(listed.messages[0], "args"), false);
  assert.equal(Object.hasOwn(listed.messages[0], "stack"), false);
  assert.equal(listed.messages[0].url, originalUrl);
  const detailed = debug.readConsole({ id: listed.messages[0].id });
  assert.equal(detailed.messages[0].text, "mapped Object");
  assert.equal(detailed.messages[0].args[0], "mapped");
  assert.equal(detailed.messages[0].args[1].preview.n, 1);
  assert.equal(detailed.messages[0].stack.length, 2);
  assert.equal(detailed.messages[0].stack[0].url, originalUrl);
  assert.equal(detailed.messages[0].stack[0].line, 10);
  assert.equal(detailed.messages[0].stack[0].column, 4);
  assert.equal(detailed.messages[0].stack[0].functionName, "fail");
  assert.equal(detailed.messages[0].stack[1].url, "https://app.local/vendor.js");
  assert.equal(detailed.messages[0].stack[1].line, 3);
  const parsed = parseAgentBrowserOperationResult(
    "console",
    sessionEnvelope(detailed),
  );
  assert.equal(parsed.messages[0].stack[0].url, originalUrl);
});

test("console drill-down args stay inside the contract JSON cap", () => {
  const debug = collector();
  const oversized = "A".repeat(MAX_DEBUG_TEXT_LENGTH + 80);
  debug.handleEvent("Runtime.consoleAPICalled", {
    type: "log",
    args: [{ type: "string", value: oversized }],
  });
  const detailed = debug.readConsole({ id: 1 });
  const arg = detailed.messages[0].args[0];
  assert.equal(typeof arg, "string");
  assert.ok(JSON.stringify(arg).length <= MAX_DEBUG_TEXT_LENGTH);
  assert.equal(arg.endsWith(DEBUG_TRUNCATION_SUFFIX), true);
  const parsed = parseAgentBrowserOperationResult(
    "console",
    sessionEnvelope(detailed),
  );
  assert.equal(parsed.messages[0].args[0], arg);
});

test("HTTP source-map fetch failure keeps the generated position", () => {
  const debug = collector();
  const generatedUrl = "https://app.local/bundle.js";
  debug.handleEvent("Debugger.scriptParsed", {
    url: generatedUrl,
    sourceMapURL: "https://app.local/missing.js.map",
  });
  debug.takePendingRemoteSourceMaps();
  debug.handleEvent("Runtime.consoleAPICalled", {
    type: "error",
    args: [{ type: "string", value: "unmapped" }],
    stackTrace: {
      callFrames: [{
        url: generatedUrl,
        lineNumber: 0,
        columnNumber: 42,
      }],
    },
  });
  const view = debug.readConsole({ id: 1 });
  assert.equal(view.messages[0].url, generatedUrl);
  assert.equal(view.messages[0].line, 0);
  assert.equal(view.messages[0].column, 42);
  assert.equal(debug.ingestSourceMap(generatedUrl, { version: 3 }), false);
});

test("network id drill-down redacts headers and truncates a textual body", () => {
  const debug = collector();
  debug.handleEvent("Network.requestWillBeSent", {
    requestId: "api",
    type: "XHR",
    timestamp: 1,
    request: {
      method: "POST",
      url: "https://api.local/users",
      headers: {
        Cookie: "sid=secret",
        Authorization: "Bearer secret",
        Accept: "application/json",
      },
    },
    initiator: {
      type: "script",
      stack: {
        callFrames: [{
          url: "https://app.local/src/api.ts",
          lineNumber: 4,
          columnNumber: 2,
          functionName: "loadUsers",
        }],
      },
    },
  });
  debug.handleEvent("Network.responseReceived", {
    requestId: "api",
    response: {
      status: 200,
      statusText: "OK",
      mimeType: "application/json",
      headers: { "Set-Cookie": "sid=other" },
    },
  });
  debug.handleEvent("Network.loadingFinished", {
    requestId: "api",
    timestamp: 1.042,
  });
  debug.attachResponseBody("api", `{"pad":"${"B".repeat(MAX_DEBUG_TEXT_LENGTH)}"}`);
  const listed = debug.readNetwork();
  assert.equal(Object.hasOwn(listed.requests[0], "requestHeaders"), false);
  assert.equal(Object.hasOwn(listed.requests[0], "body"), false);
  assert.equal(Object.hasOwn(listed.requests[0], "requestBody"), false);
  const detailed = debug.readNetwork({ id: listed.requests[0].id });
  assert.equal(detailed.requests[0].requestHeaders.Cookie, REDACTED_HEADER_VALUE);
  assert.equal(
    detailed.requests[0].requestHeaders.Authorization,
    REDACTED_HEADER_VALUE,
  );
  assert.equal(detailed.requests[0].requestHeaders.Accept, "application/json");
  assert.equal(
    detailed.requests[0].body.endsWith(DEBUG_TRUNCATION_SUFFIX),
    true,
  );
  assert.equal(detailed.requests[0].body.length, MAX_DEBUG_TEXT_LENGTH);
  assert.equal(detailed.requests[0].initiator.url, "https://app.local/src/api.ts");
  const parsed = parseAgentBrowserOperationResult(
    "network",
    sessionEnvelope(detailed),
  );
  assert.equal(parsed.requests[0].requestHeaders.Cookie, REDACTED_HEADER_VALUE);
});

test("network id drill-down exposes a truncated JSON/form requestBody from postData", () => {
  const debug = collector();
  const oversized = `{"name":"${"N".repeat(MAX_DEBUG_TEXT_LENGTH)}"}`;
  debug.handleEvent("Network.requestWillBeSent", {
    requestId: "create",
    type: "XHR",
    timestamp: 1,
    request: {
      method: "POST",
      url: "https://api.local/users",
      headers: { "Content-Type": "application/json" },
      postData: oversized,
    },
  });
  debug.handleEvent("Network.loadingFinished", {
    requestId: "create",
    timestamp: 1.01,
  });
  const listed = debug.readNetwork();
  assert.equal(Object.hasOwn(listed.requests[0], "requestBody"), false);
  assert.equal(Object.hasOwn(listed.requests[0], "body"), false);
  const detailed = debug.readNetwork({ id: listed.requests[0].id });
  assert.equal(
    detailed.requests[0].requestBody.endsWith(DEBUG_TRUNCATION_SUFFIX),
    true,
  );
  assert.equal(detailed.requests[0].requestBody.length, MAX_DEBUG_TEXT_LENGTH);
  const parsed = parseAgentBrowserOperationResult(
    "network",
    sessionEnvelope(detailed),
  );
  assert.equal(parsed.requests[0].requestBody, detailed.requests[0].requestBody);

  debug.handleEvent("Network.requestWillBeSent", {
    requestId: "form",
    type: "Fetch",
    timestamp: 2,
    request: {
      method: "POST",
      url: "https://api.local/login",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      postData: "user=&password=",
    },
  });
  const formId = debug.readNetwork({ urlContains: "/login" }).requests[0].id;
  const form = debug.readNetwork({ id: formId });
  assert.equal(form.requests[0].requestBody, "user=&password=");
});

test("network loadingFailed exposes blockedReason on id drill-down", () => {
  const debug = collector();
  debug.handleEvent("Network.requestWillBeSent", {
    requestId: "blocked",
    type: "XHR",
    request: { method: "GET", url: "https://api.local/ads" },
  });
  debug.handleEvent("Network.loadingFailed", {
    requestId: "blocked",
    errorText: "net::ERR_BLOCKED_BY_CLIENT",
    blockedReason: "csp",
  });
  const listed = debug.readNetwork();
  assert.equal(Object.hasOwn(listed.requests[0], "blockedReason"), false);
  const detailed = debug.readNetwork({ id: listed.requests[0].id });
  assert.equal(detailed.requests[0].blockedReason, "csp");
  assert.equal(detailed.requests[0].errorText, "net::ERR_BLOCKED_BY_CLIENT");
});

test("since_id omits older console and network rows and last_id is a high-water cursor", () => {
  const debug = collector();
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("log", "one"));
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("log", "two"));
  const first = debug.readConsole();
  assert.equal(first.lastId, 2);
  debug.handleEvent("Runtime.consoleAPICalled", consoleApi("log", "three"));
  const newer = debug.readConsole({ sinceId: first.lastId });
  assert.deepEqual(
    newer.messages.map((message) => message.text),
    ["three"],
  );
  sendRequest(debug, {
    requestId: "a",
    url: "https://api.local/a",
    type: "XHR",
    status: 200,
  });
  sendRequest(debug, {
    requestId: "b",
    url: "https://api.local/b",
    type: "XHR",
    status: 200,
  });
  const networkFirst = debug.readNetwork();
  const after = debug.readNetwork({ sinceId: networkFirst.requests[0].id });
  assert.deepEqual(
    after.requests.map((request) => request.url),
    ["https://api.local/b"],
  );
});

test("url_contains filters the network list", () => {
  const debug = collector();
  sendRequest(debug, {
    requestId: "users",
    url: "https://api.local/users",
    type: "XHR",
    status: 200,
  });
  sendRequest(debug, {
    requestId: "other",
    url: "https://api.local/other",
    type: "XHR",
    status: 200,
  });
  const filtered = debug.readNetwork({ urlContains: "/users" });
  assert.deepEqual(
    filtered.requests.map((request) => request.url),
    ["https://api.local/users"],
  );
});

test("network wait completes when a matching request finishes", async () => {
  const debug = collector();
  const waiting = debug.waitForNetwork({ urlContains: "/users" });
  sendRequest(debug, {
    requestId: "other",
    url: "https://api.local/other",
    type: "XHR",
    status: 200,
  });
  sendRequest(debug, {
    requestId: "users",
    url: "https://api.local/users",
    type: "XHR",
    status: 200,
  });
  const view = await waiting.promise;
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].url, "https://api.local/users");
  assert.equal(view.requests[0].outcome, "finished");
});

