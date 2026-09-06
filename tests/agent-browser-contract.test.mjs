import assert from "node:assert/strict";
import test from "node:test";
import {
  agentBrowserClaimControlSuccessResponse,
  agentBrowserSuccessResponse,
  createAgentBrowserClaimControlRequest,
  createAgentBrowserControlChangedEvent,
  createAgentBrowserReleaseOwnerRequest,
  createAgentBrowserRequest,
  isAgentBrowserProcessMessage,
  parseAgentBrowserControlChangedEvent,
  parseAgentBrowserNavigationRequest,
  MAX_AGENT_BROWSER_DEBUG_ARGS,
  MAX_AGENT_BROWSER_DEBUG_FUNCTION_LENGTH,
  MAX_AGENT_BROWSER_DEBUG_LIMIT,
  parseAgentBrowserOperationResult,
  parseAgentBrowserPopoutRequest,
  parseAgentBrowserProcessRequest,
  parseAgentBrowserProcessResponse,
  parseAgentBrowserProjection,
  parseAgentBrowserProjections,
  parseAgentBrowserToolPayload,
} from "@minke/harness-overlay/agent-browser-contract.ts";
import {
  AGENT_BROWSER_HISTORY_DEFAULT_LIMIT,
  AGENT_BROWSER_HISTORY_LIMIT,
  parseAgentBrowserHistoryClearRequest,
  parseAgentBrowserHistoryDeleteRequest,
  parseAgentBrowserHistoryReadRequest,
  parseAgentBrowserHistorySnapshot,
} from "@minke/harness-overlay/agent-browser-history-contract.ts";

test("Agent Browser browsing-footprint contracts are strict and consistent", () => {
  assert.equal(AGENT_BROWSER_HISTORY_DEFAULT_LIMIT, 100);
  assert.deepEqual(
    parseAgentBrowserHistoryReadRequest({
      limit: 50,
      actor: "human",
      before: {
        visitId: 40,
        visitedAt: 1_700,
      },
      query: "  release   notes  ",
    }),
    {
      limit: 50,
      actor: "human",
      before: {
        visitId: 40,
        visitedAt: 1_700,
      },
      query: "release notes",
    },
  );
  assert.deepEqual(
    parseAgentBrowserHistoryReadRequest({
      limit: 50,
      query: "   ",
    }),
    { limit: 50 },
  );
  assert.deepEqual(
    parseAgentBrowserHistoryClearRequest({ confirm: true }),
    { confirm: true },
  );
  assert.deepEqual(
    parseAgentBrowserHistoryDeleteRequest({ visitId: 42 }),
    { visitId: 42 },
  );
  assert.throws(
    () =>
      parseAgentBrowserHistoryReadRequest({
        limit: AGENT_BROWSER_HISTORY_LIMIT + 1,
      }),
    /limit/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserHistoryReadRequest({
        before: {
          visitId: 0,
          visitedAt: 1_700,
        },
        limit: 50,
      }),
    /cursor visit id/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserHistoryClearRequest({
        confirm: false,
      }),
    /clear request/u,
  );
  for (const request of [
    { visitId: 0 },
    { visitId: 1.5 },
    { visitId: 1, unexpected: true },
  ]) {
    assert.throws(
      () => parseAgentBrowserHistoryDeleteRequest(request),
      /delete/u,
    );
  }

  const snapshot = {
    totalVisits: 3,
    retainedVisits: 3,
    uniquePaths: 1,
    agentVisits: 2,
    humanVisits: 1,
    visits: [
      {
        visitId: 3,
        visitedAt: 1_800,
        actor: "agent",
        navigationKind: "same-document",
        url: "https://example.com/items/42?view=comments#fifth",
        title: "Item 42 comments",
        searchQuery: "item 42",
        faviconUrl: "https://example.com/icons/site.png",
        origin: "https://example.com",
        pathname: "/items/42",
        pathKey: "https://example.com/items/42",
        pathVisitCount: 3,
        pathAgentVisits: 2,
        pathHumanVisits: 1,
      },
    ],
    nextCursor: {
      visitId: 3,
      visitedAt: 1_800,
    },
  };
  assert.deepEqual(
    parseAgentBrowserHistorySnapshot(snapshot),
    snapshot,
  );
  assert.throws(
    () =>
      parseAgentBrowserHistorySnapshot({
        ...snapshot,
        visits: [
          {
            ...snapshot.visits[0],
            pathKey: "https://example.com/items/other",
          },
        ],
      }),
    /inconsistent URL fields/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserHistorySnapshot({
        ...snapshot,
        visits: [
          {
            ...snapshot.visits[0],
            visitedAt: 8_640_000_000_000_001,
          },
        ],
      }),
    /timestamp/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserHistorySnapshot({
        ...snapshot,
        nextCursor: {
          visitId: 2,
          visitedAt: 1_800,
        },
      }),
    /cursor must match/u,
  );
  assert.equal(
    parseAgentBrowserHistorySnapshot({
      ...snapshot,
      visits: [{
        ...snapshot.visits[0],
        faviconUrl: "https://cdn.example.com/site.png",
      }],
    }).visits[0]?.faviconUrl,
    "https://example.com/favicon.ico",
  );
  assert.throws(
    () =>
      parseAgentBrowserHistorySnapshot({
        ...snapshot,
        visits: [{
          ...snapshot.visits[0],
          faviconUrl: "data:image/png;base64,unsafe",
        }],
      }),
    /favicon URL/u,
  );
});

test("Agent Browser process requests are exact, bounded, and owner-scoped", () => {
  const request = createAgentBrowserRequest(
    7,
    "conversation-1",
    "navigate",
    {
      sessionId: "browser-1",
      url: "https://example.com/docs",
    },
  );
  assert.deepEqual(request, {
    channel: "minke:agent-browser:process",
    protocolVersion: 1,
    requestId: 7,
    type: "request",
    operation: "navigate",
    ownerSessionId: "conversation-1",
    payload: {
      sessionId: "browser-1",
      url: "https://example.com/docs",
    },
  });
  assert.deepEqual(parseAgentBrowserProcessRequest(request), request);
  assert.equal(isAgentBrowserProcessMessage(request), true);
  assert.equal(
    isAgentBrowserProcessMessage({
      ...request,
      channel: "minke:harness-control",
    }),
    false,
  );

  assert.throws(
    () =>
      parseAgentBrowserProcessRequest({
        ...request,
        unexpected: true,
      }),
    /invalid Agent Browser process request/u,
  );
  assert.throws(
    () =>
      createAgentBrowserRequest(8, "conversation/escape", "open", {
        url: "https://example.com/",
      }),
    /owner session id/u,
  );
  assert.throws(
    () =>
      createAgentBrowserRequest(9, "conversation-1", "open", {
        url: "file:///tmp/private",
      }),
    /invalid Agent Browser URL/u,
  );

  const exactClick = createAgentBrowserRequest(
    10,
    "conversation-1",
    "click",
    {
      sessionId: "browser-1",
      target: { ref: "s2:e4" },
    },
  );
  assert.deepEqual(
    parseAgentBrowserProcessRequest(exactClick).payload,
    {
      sessionId: "browser-1",
      target: { ref: "s2:e4" },
    },
  );
  assert.throws(
    () =>
      createAgentBrowserRequest(
        11,
        "conversation-1",
        "click",
        {
          sessionId: "browser-1",
          target: {
            withinRef: "s2:e1",
            exact: false,
          },
        },
      ),
    /requires a role, name, placeholder, or URL constraint/u,
  );
  assert.throws(
    () =>
      createAgentBrowserRequest(
        12,
        "conversation-1",
        "click",
        {
          sessionId: "browser-1",
          target: {
            name: "Submit",
            exact: true,
            index: -1,
          },
        },
      ),
    /index/u,
  );

  const generatedLocate = createAgentBrowserRequest(
    15,
    "conversation-1",
    "locate",
    {
      sessionId: "browser-1",
      code:
        'page.locator("tr.athing").nth(11).next().getByRole("link", {name:/comments?/i})',
    },
  );
  assert.deepEqual(
    parseAgentBrowserProcessRequest(generatedLocate).payload,
    {
      sessionId: "browser-1",
      code:
        'page.locator("tr.athing").nth(11).next().getByRole("link", {name:/comments?/i})',
    },
  );
  assert.throws(
    () =>
      createAgentBrowserRequest(
        16,
        "conversation-1",
        "locate",
        {
          sessionId: "browser-1",
          code: "x".repeat(4_097),
        },
      ),
    /locator code/u,
  );
  for (const code of ["", " \n\t "]) {
    assert.throws(
      () =>
        createAgentBrowserRequest(
          17,
          "conversation-1",
          "locate",
          {
            sessionId: "browser-1",
            code,
          },
        ),
      /locator code/u,
    );
  }
});

test("Agent Browser generated locator results authorize one direct actionable ref only", () => {
  const result = {
    sessionId: "browser-1",
    generation: 2,
    owner: "agent",
    status: "ready",
    snapshotRequired: false,
    snapshotId: "s2",
    node: {
      ref: "s2:e4",
      role: "link",
      name: "18 comments",
      actionable: true,
      disabled: false,
      actions: ["click", "press"],
      url: "https://example.com/item?id=12",
      match: true,
    },
  };
  assert.deepEqual(
    parseAgentBrowserOperationResult("locate", result),
    result,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("locate", {
        ...result,
        node: {
          ...result.node,
          match: false,
        },
      }),
    /direct enabled actionable/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("locate", {
        ...result,
        node: {
          ...result.node,
          actionable: false,
          actions: undefined,
        },
      }),
    /direct enabled actionable/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("locate", {
        ...result,
        node: {
          ...result.node,
          disabled: true,
          actions: undefined,
        },
      }),
    /direct enabled actionable/u,
  );
  const {
    disabled: _disabled,
    ...nodeWithoutDisabled
  } = result.node;
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("locate", {
        ...result,
        node: nodeWithoutDisabled,
      }),
    /direct enabled actionable/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("locate", {
        ...result,
        snapshotId: "s3",
      }),
    /snapshot.*generation/iu,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("locate", {
        ...result,
        node: {
          ...result.node,
          ref: "s3:e4",
        },
      }),
    /ref.*snapshot/iu,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("locate", {
        ...result,
        node: {
          ...result.node,
          parentRef: "s3:e1",
        },
      }),
    /parent ref.*snapshot/iu,
  );
});

test("Agent Browser actions accept one scoped semantic target", () => {
  const request = createAgentBrowserRequest(
    13,
    "conversation-1",
    "click",
    {
      sessionId: "browser-1",
      target: {
        withinRef: "s2:e5",
        role: "link",
        name: "Open details",
        url: "/items/5",
        exact: true,
      },
    },
  );
  assert.deepEqual(
    parseAgentBrowserProcessRequest(request).payload,
    {
      sessionId: "browser-1",
      target: {
        withinRef: "s2:e5",
        role: "link",
        name: "Open details",
        url: "/items/5",
        exact: true,
      },
    },
  );
  assert.throws(
    () =>
      createAgentBrowserRequest(
        14,
        "conversation-1",
        "click",
        {
          sessionId: "browser-1",
          target: {
            ref: "s2:e6",
            role: "link",
          },
        },
      ),
    /target/u,
  );
});

test("Agent Browser owner release is an exact one-way lifecycle frame", () => {
  const request = createAgentBrowserReleaseOwnerRequest(
    "conversation-release",
  );
  assert.deepEqual(request, {
    channel: "minke:agent-browser:process",
    protocolVersion: 1,
    type: "release-owner",
    ownerSessionId: "conversation-release",
  });
  assert.deepEqual(parseAgentBrowserProcessRequest(request), request);
  assert.throws(
    () =>
      parseAgentBrowserProcessRequest({
        ...request,
        requestId: 10,
      }),
    /release owner request/u,
  );
});

test("Agent Browser control handoffs are exact parent lifecycle events", () => {
  const event = createAgentBrowserControlChangedEvent(
    "conversation-control",
    "browser-control",
    "human",
    3,
  );
  assert.deepEqual(event, {
    channel: "minke:agent-browser:process",
    protocolVersion: 1,
    type: "control-changed",
    ownerSessionId: "conversation-control",
    sessionId: "browser-control",
    owner: "human",
    controlRevision: 3,
  });
  assert.deepEqual(
    parseAgentBrowserControlChangedEvent(event),
    event,
  );
  assert.throws(
    () =>
      parseAgentBrowserControlChangedEvent({
        ...event,
        requestId: 11,
      }),
    /control changed event/u,
  );
});

test("automatic control claims are correlated and revision guarded", () => {
  const request = createAgentBrowserClaimControlRequest(
    12,
    "conversation-control",
    "browser-control",
    3,
  );
  assert.deepEqual(parseAgentBrowserProcessRequest(request), request);
  assert.deepEqual(request, {
    channel: "minke:agent-browser:process",
    protocolVersion: 1,
    requestId: 12,
    type: "claim-control",
    ownerSessionId: "conversation-control",
    sessionId: "browser-control",
    expectedControlRevision: 3,
  });
  assert.throws(
    () =>
      createAgentBrowserClaimControlRequest(
        12,
        "conversation-control",
        "browser-control",
        0,
      ),
    /expected control revision/u,
  );

  const response = agentBrowserClaimControlSuccessResponse(12, {
    sessionId: "browser-control",
    generation: 4,
    owner: "agent",
    status: "ready",
    snapshotRequired: true,
    controlRevision: 4,
    url: "https://example.com/",
  });
  assert.deepEqual(
    parseAgentBrowserProcessResponse("claim-control", response),
    response,
  );
  assert.throws(
    () =>
      agentBrowserClaimControlSuccessResponse(12, {
        ...response.result,
        status: "paused",
      }),
    /claim control result/u,
  );
});

test("Agent Browser popout contracts validate sessions and hosts", () => {
  assert.deepEqual(parseAgentBrowserPopoutRequest({ sessionId: "s1" }), {
    sessionId: "s1",
  });
  assert.throws(
    () => parseAgentBrowserPopoutRequest({ sessionId: "s1", url: "https://x" }),
    /popout request/u,
  );
  assert.throws(
    () => parseAgentBrowserPopoutRequest({ sessionId: "  " }),
    /session id/u,
  );
  assert.throws(
    () => parseAgentBrowserPopoutRequest(undefined),
    /popout request/u,
  );

  const base = {
    sessionId: "browser-1",
    partition: "minke-agent-4bb22c",
    generation: 1,
    owner: "agent",
    status: "pending",
  };
  assert.equal(parseAgentBrowserProjection(base).host, undefined);
  assert.equal(
    parseAgentBrowserProjection({ ...base, host: "popout" }).host,
    "popout",
  );
  assert.equal(
    parseAgentBrowserProjection({ ...base, host: "sidebar" }).host,
    "sidebar",
  );
  assert.throws(
    () => parseAgentBrowserProjection({ ...base, host: "floating" }),
    /projection host/u,
  );
  assert.throws(
    () => parseAgentBrowserProjection({ ...base, host: 1 }),
    /projection host/u,
  );
});

test("Agent Browser renderer projections reject persistent identity", () => {
  const projection = parseAgentBrowserProjection({
    sessionId: "browser-1",
    partition: "minke-agent-4bb22c",
    generation: 1,
    owner: "agent",
    status: "pending",
    navigation: {
      loading: false,
      canGoBack: true,
      canGoForward: false,
    },
    url: "https://example.com/",
    cursor: {
      sequence: 1,
      phase: "idle",
      point: { x: 320.5, y: 240.25 },
      viewport: { width: 860, height: 863 },
      durationMs: 180,
    },
  });
  assert.equal(projection.partition, "minke-agent-4bb22c");
  assert.deepEqual(projection.cursor, {
    sequence: 1,
    phase: "idle",
    point: { x: 320.5, y: 240.25 },
    viewport: { width: 860, height: 863 },
    durationMs: 180,
  });
  assert.deepEqual(projection.navigation, {
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
  assert.deepEqual(parseAgentBrowserProjections([projection]), [
    projection,
  ]);

  assert.throws(
    () =>
      parseAgentBrowserProjection({
        ...projection,
        partition: "persist:minke-tabs-web",
      }),
    /partition/u,
  );
  assert.throws(
    () => parseAgentBrowserProjections(new Array(33).fill(projection)),
    /projection list/u,
  );

  for (const cursor of [
    {
      ...projection.cursor,
      phase: "dragging",
    },
    {
      ...projection.cursor,
      point: { x: Number.NaN, y: 10 },
    },
    {
      ...projection.cursor,
      point: { x: -0.1, y: 10 },
    },
    {
      ...projection.cursor,
      point: { x: 861, y: 10 },
    },
    {
      ...projection.cursor,
      point: { x: 10, y: 864 },
    },
    {
      ...projection.cursor,
      viewport: { width: 0, height: 863 },
    },
    {
      ...projection.cursor,
      durationMs: 2_001,
    },
    {
      ...projection.cursor,
      unexpected: true,
    },
  ]) {
    assert.throws(
      () =>
        parseAgentBrowserProjection({
          ...projection,
          cursor,
        }),
      /cursor/u,
    );
  }
});

test("Agent Browser human navigation requests are exact and bounded", () => {
  assert.deepEqual(
    parseAgentBrowserNavigationRequest({
      sessionId: "browser-1",
      command: "reload",
    }),
    {
      sessionId: "browser-1",
      command: "reload",
    },
  );
  for (const request of [
    { sessionId: "browser-1", command: "navigate" },
    {
      sessionId: "browser-1",
      command: "back",
      unexpected: true,
    },
  ]) {
    assert.throws(
      () => parseAgentBrowserNavigationRequest(request),
      /navigation request/u,
    );
  }
});

test("Agent Browser exposes the same bounded history commands to agents", () => {
  const request = createAgentBrowserRequest(
    15,
    "conversation-history",
    "history",
    {
      sessionId: "browser-1",
      command: "back",
    },
  );
  assert.deepEqual(parseAgentBrowserProcessRequest(request), request);
  assert.deepEqual(request.payload, {
    sessionId: "browser-1",
    command: "back",
  });
  assert.throws(
    () =>
      createAgentBrowserRequest(
        16,
        "conversation-history",
        "history",
        {
          sessionId: "browser-1",
          command: "home",
        },
      ),
    /navigation request/u,
  );
});

test("Agent Browser scroll requests and results expose bounded movement evidence", () => {
  const request = createAgentBrowserRequest(
    17,
    "conversation-scroll",
    "scroll",
    {
      sessionId: "browser-1",
      direction: "down",
      amount: 640,
      withinRef: "s2:e4",
    },
  );
  assert.deepEqual(parseAgentBrowserProcessRequest(request), request);
  assert.deepEqual(request.payload, {
    sessionId: "browser-1",
    direction: "down",
    amount: 640,
    withinRef: "s2:e4",
  });

  for (const payload of [
    {
      sessionId: "browser-1",
      direction: "sideways",
      amount: 640,
    },
    {
      sessionId: "browser-1",
      direction: "down",
      amount: 0,
    },
    {
      sessionId: "browser-1",
      direction: "bottom",
      amount: 640,
    },
  ]) {
    assert.throws(
      () =>
        createAgentBrowserRequest(
          18,
          "conversation-scroll",
          "scroll",
          payload,
        ),
      /scroll/iu,
    );
  }

  const result = {
    sessionId: "browser-1",
    generation: 2,
    owner: "agent",
    status: "ready",
    snapshotRequired: true,
    url: "https://example.com/",
    scope: "s2:e4",
    beforeX: 0,
    beforeY: 20,
    afterX: 0,
    afterY: 660,
    maxX: 0,
    maxY: 2_000,
    moved: true,
  };
  assert.deepEqual(
    parseAgentBrowserOperationResult("scroll", result),
    result,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("scroll", {
        ...result,
        moved: false,
      }),
    /scroll movement/iu,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("scroll", {
        ...result,
        scope: "invented",
      }),
    /scroll scope/iu,
  );
});

test("Agent Browser snapshot results expose only generation-bound refs", () => {
  const response = agentBrowserSuccessResponse(3, "snapshot", {
    sessionId: "browser-1",
    generation: 4,
    owner: "agent",
    status: "ready",
    snapshotRequired: false,
    url: "https://example.com/",
    snapshotId: "snapshot-4",
    nodes: [
      {
        ref: "s4:e1",
        role: "group",
        name: "Checkout",
        depth: 2,
      },
      {
        ref: "s4:e2",
        role: "button",
        name: "Continue",
        depth: 3,
        parentRef: "s4:e1",
        actionable: true,
        disabled: false,
        actions: ["click", "press"],
        placeholder: "Search",
        url: "https://example.com/continue",
      },
    ],
  });
  assert.equal(response.type, "response");
  assert.equal(response.result.nodes[1].ref, "s4:e2");
  assert.equal(response.result.nodes[1].depth, 3);
  assert.equal(response.result.nodes[1].parentRef, "s4:e1");
  assert.deepEqual(
    response.result.nodes[1].actions,
    ["click", "press"],
  );
  assert.equal(response.result.nodes[1].placeholder, "Search");
  assert.equal(
    response.result.nodes[1].url,
    "https://example.com/continue",
  );

  assert.throws(
    () =>
      agentBrowserSuccessResponse(4, "snapshot", {
        ...response.result,
        nodes: [
          {
            ref: "e1",
            role: "button",
            name: "Continue",
          },
        ],
      }),
    /ref/u,
  );
  for (const actions of [
    ["click", "click"],
    ["click", "drag"],
  ]) {
    assert.throws(
      () =>
        agentBrowserSuccessResponse(4, "snapshot", {
          ...response.result,
          nodes: [{
            ...response.result.nodes[1],
            parentRef: undefined,
            actions,
          }],
        }),
      /node actions/u,
    );
  }
  assert.throws(
    () =>
      agentBrowserSuccessResponse(4, "snapshot", {
        ...response.result,
        nodes: [{
          ref: "s4:e3",
          role: "group",
          name: "Structural group",
          actionable: false,
          actions: ["click"],
        }],
      }),
    /actions require an enabled actionable node/u,
  );
});

test("Agent Browser find requests and paged local results are strict", () => {
  const request = createAgentBrowserRequest(
    17,
    "conversation-find",
    "find",
    {
      sessionId: "browser-1",
      query: {
        withinRef: "s4:e1",
        text: "requested action",
        actionable: true,
        exact: false,
        index: 7,
      },
      view: "context",
      depth: 2,
      limit: 20,
    },
  );
  assert.deepEqual(parseAgentBrowserProcessRequest(request), request);
  assert.equal(request.payload.query.index, 7);

  for (const index of [-1, 50_000]) {
    assert.throws(
      () =>
        createAgentBrowserRequest(
          18,
          "conversation-find",
          "find",
          {
            sessionId: "browser-1",
            query: {
              text: "requested action",
              exact: false,
              index,
            },
            view: "context",
            depth: 2,
            limit: 20,
          },
        ),
      /find index/u,
    );
  }
  assert.throws(
    () =>
      createAgentBrowserRequest(
        18,
        "conversation-find",
        "find",
        {
          sessionId: "browser-1",
          query: {
            exact: false,
            index: 0,
          },
          view: "context",
          depth: 2,
          limit: 20,
        },
      ),
    /requires a scope or semantic constraint/u,
  );

  const response = agentBrowserSuccessResponse(17, "find", {
    sessionId: "browser-1",
    generation: 4,
    owner: "agent",
    status: "ready",
    snapshotRequired: false,
    snapshotId: "s4",
    nodes: [{
      ref: "s4:e2",
      role: "link",
      name: "Requested action",
      actionable: true,
      match: true,
    }],
    view: "context",
    totalNodes: 10_000,
    actionableNodes: 800,
    totalMatches: 21,
    offset: 0,
    indexTruncated: false,
    nextCursor: "f4:c1",
  });
  assert.equal(response.result.totalMatches, 21);
  assert.equal(response.result.nextCursor, "f4:c1");
  assert.equal(response.result.nodes[0].match, true);

  const ordinalOutOfRange = agentBrowserSuccessResponse(18, "find", {
    sessionId: "browser-1",
    generation: 4,
    owner: "agent",
    status: "ready",
    snapshotRequired: false,
    snapshotId: "s4",
    nodes: [],
    view: "subtree",
    totalNodes: 10_000,
    actionableNodes: 800,
    totalMatches: 5,
    offset: 7,
    indexTruncated: false,
  });
  assert.equal(ordinalOutOfRange.result.totalMatches, 5);
  assert.equal(ordinalOutOfRange.result.offset, 7);
  assert.deepEqual(ordinalOutOfRange.result.nodes, []);
  assert.equal(
    Object.hasOwn(ordinalOutOfRange.result, "nextCursor"),
    false,
  );

  const continuation = createAgentBrowserRequest(
    18,
    "conversation-find",
    "find",
    {
      sessionId: "browser-1",
      cursor: "f4:c1",
    },
  );
  assert.deepEqual(continuation.payload, {
    sessionId: "browser-1",
    cursor: "f4:c1",
  });
  assert.throws(
    () =>
      createAgentBrowserRequest(
        19,
        "conversation-find",
        "find",
        {
          sessionId: "browser-1",
          query: {
            text: "requested action",
            exact: false,
          },
          view: "context",
          depth: 9,
          limit: 20,
        },
      ),
    /depth/u,
  );
});

test("Agent Browser debug payloads reject unknown keys, bad types, and over-limit values", () => {
  const sessionId = "browser-1";
  assert.deepEqual(
    parseAgentBrowserToolPayload("console", {
      sessionId,
      levels: ["error", "warn"],
      limit: 20,
      enable: true,
    }),
    {
      sessionId,
      levels: ["error", "warn"],
      limit: 20,
      enable: true,
    },
  );
  assert.deepEqual(
    parseAgentBrowserToolPayload("console", {
      sessionId,
      clear: true,
    }),
    { sessionId, clear: true },
  );
  assert.deepEqual(
    parseAgentBrowserToolPayload("console", {
      sessionId,
      id: 7,
      sinceId: 3,
    }),
    { sessionId, id: 7, sinceId: 3 },
  );
  assert.deepEqual(
    parseAgentBrowserToolPayload("network", {
      sessionId,
      resourceTypes: ["XHR", "Fetch", "Document"],
      failuresOnly: true,
      enable: false,
    }),
    {
      sessionId,
      resourceTypes: ["XHR", "Fetch", "Document"],
      failuresOnly: true,
      enable: false,
    },
  );
  assert.deepEqual(
    parseAgentBrowserToolPayload("network", {
      sessionId,
      id: 4,
      sinceId: 2,
      urlContains: "/api",
      wait: true,
      timeoutMs: 5_000,
    }),
    {
      sessionId,
      id: 4,
      sinceId: 2,
      urlContains: "/api",
      wait: true,
      timeoutMs: 5_000,
    },
  );
  assert.deepEqual(
    parseAgentBrowserToolPayload("execute", {
      sessionId,
      function: "() => window.__APP_STATE__",
      args: [{ id: 1 }],
      awaitPromise: false,
    }),
    {
      sessionId,
      function: "() => window.__APP_STATE__",
      args: [{ id: 1 }],
      awaitPromise: false,
    },
  );

  assert.throws(
    () =>
      parseAgentBrowserToolPayload("console", {
        sessionId,
        extra: true,
      }),
    /invalid Agent Browser console payload/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserToolPayload("network", {
        sessionId,
        failuresOnly: "yes",
      }),
    /failuresOnly/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserToolPayload("console", {
        sessionId,
        limit: MAX_AGENT_BROWSER_DEBUG_LIMIT + 1,
      }),
    /limit/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserToolPayload("execute", {
        sessionId,
      }),
    /invalid Agent Browser execute payload/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserToolPayload("execute", {
        sessionId,
        function: "x".repeat(MAX_AGENT_BROWSER_DEBUG_FUNCTION_LENGTH + 1),
      }),
    /function/u,
  );
  assert.throws(
    () =>
      parseAgentBrowserToolPayload("execute", {
        sessionId,
        function: "() => 1",
        args: Array.from(
          { length: MAX_AGENT_BROWSER_DEBUG_ARGS + 1 },
          (_, index) => index,
        ),
      }),
    /args/u,
  );
});

test("Agent Browser debug results require the documented fields and reject extras", () => {
  const session = {
    sessionId: "browser-1",
    generation: 2,
    owner: "agent",
    status: "ready",
    snapshotRequired: false,
  };
  const consoleResult = {
    ...session,
    enabled: true,
    truncated: false,
    totalCount: 1,
    lastId: 1,
    messages: [{
      id: 1,
      level: "error",
      source: "console",
      text: "boom",
      timestamp: 1_700,
      url: "https://app.local/main.ts",
      line: 12,
      column: 4,
    }],
  };
  assert.deepEqual(
    parseAgentBrowserOperationResult("console", consoleResult),
    consoleResult,
  );
  const consoleDetail = {
    ...consoleResult,
    messages: [{
      ...consoleResult.messages[0],
      args: [
        "boom",
        { type: "object", className: "Object", preview: { n: 1 } },
      ],
      stack: [
        { url: "https://app.local/src/app.ts", line: 10, column: 4, functionName: "fail" },
        { url: "https://app.local/vendor.js", line: 3, column: 1 },
      ],
    }],
  };
  assert.deepEqual(
    parseAgentBrowserOperationResult("console", consoleDetail),
    consoleDetail,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("console", {
        ...consoleResult,
        extra: true,
      }),
    /invalid Agent Browser console result/u,
  );

  const networkResult = {
    ...session,
    enabled: true,
    truncated: false,
    totalCount: 1,
    lastId: 1,
    requests: [{
      id: 1,
      method: "GET",
      url: "https://api.local/data",
      resourceType: "XHR",
      outcome: "finished",
      timestamp: 1_700,
      status: 200,
      statusText: "OK",
      durationMs: 42,
    }],
  };
  assert.deepEqual(
    parseAgentBrowserOperationResult("network", networkResult),
    networkResult,
  );
  const networkDetail = {
    ...networkResult,
    requests: [{
      ...networkResult.requests[0],
      requestHeaders: {
        Cookie: "[redacted]",
        Authorization: "[redacted]",
        Accept: "application/json",
      },
      responseHeaders: { "Content-Type": "application/json" },
      requestBody: "{\"name\":\"\"}",
      body: "{\"ok\":true}",
      initiator: {
        url: "https://app.local/src/api.ts",
        line: 4,
        column: 2,
        functionName: "load",
      },
      blockedReason: "csp",
    }],
  };
  assert.deepEqual(
    parseAgentBrowserOperationResult("network", networkDetail),
    networkDetail,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("network", {
        ...networkResult,
        enabled: "yes",
      }),
    /invalid Agent Browser network result/u,
  );

  const executeResult = {
    ...session,
    ok: true,
    value: "{\"n\":1}",
  };
  assert.deepEqual(
    parseAgentBrowserOperationResult("execute", executeResult),
    executeResult,
  );
  assert.throws(
    () =>
      parseAgentBrowserOperationResult("execute", {
        ...session,
        ok: true,
      }),
    /exactly one of value or errorText/u,
  );
});

