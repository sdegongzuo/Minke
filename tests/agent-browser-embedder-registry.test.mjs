import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentBrowserEmbedderRegistry,
} from "@minke/desktop/main/agent-browser/embedder-registry.ts";

function fakeEmbedder() {
  return { destroyed: false };
}

function candidate(sender, frameUrl) {
  return {
    sender,
    senderFrame: frameUrl === undefined ? null : { url: frameUrl },
  };
}

test("Agent Browser embedder registry authorizes only registered harness frames", () => {
  const registry = new AgentBrowserEmbedderRegistry(
    () => "minke-test://harness/index",
  );
  const embedder = fakeEmbedder();
  const stranger = fakeEmbedder();

  assert.equal(
    registry.authorize(candidate(embedder, "minke-test://harness/app")),
    false,
  );

  registry.register(embedder);
  assert.equal(
    registry.authorize(candidate(embedder, "minke-test://harness/app")),
    true,
  );

  assert.equal(
    registry.authorize(
      candidate(stranger, "minke-test://harness/app"),
    ),
    false,
  );
  assert.equal(
    registry.authorize(
      candidate(embedder, "https://evil.example/index"),
    ),
    false,
  );
  assert.equal(
    registry.authorize(candidate(embedder, "not a url")),
    false,
  );
  assert.equal(registry.authorize(candidate(embedder)), false);
});

test("Agent Browser embedder registry drops unregistered and torn-down windows", () => {
  const registry = new AgentBrowserEmbedderRegistry(
    () => "minke-test://harness/index",
  );
  const embedder = fakeEmbedder();
  registry.register(embedder);
  assert.equal(
    registry.authorize(
      candidate(embedder, "minke-test://harness/index"),
    ),
    true,
  );

  registry.unregister(embedder);
  assert.equal(
    registry.authorize(
      candidate(embedder, "minke-test://harness/index"),
    ),
    false,
  );

  registry.unregister(embedder);
  const harnessless = new AgentBrowserEmbedderRegistry(() => undefined);
  harnessless.register(embedder);
  assert.equal(
    harnessless.authorize(
      candidate(embedder, "minke-test://harness/index"),
    ),
    false,
  );
});
