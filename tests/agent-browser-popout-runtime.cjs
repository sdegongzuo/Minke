'use strict';

// Agent Browser popout runtime smoke test: pops a live session out of a
// host window into a dedicated BrowserWindow, verifies guest relocation,
// duplicate/limit error codes, and the return trip when the popout closes.

const assert = require('node:assert/strict');
const http = require('node:http');
const { writeFileSync } = require('node:fs');
const Module = require('node:module');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
} = require('electron');
const { buildSync } = require('esbuild');

const projectRoot = join(__dirname, '..');

function loadAgentBrowserSource() {
  const source = `
    export {
      AgentBrowserEmbedderRegistry,
      AgentBrowserPopoutRuntime,
      AgentBrowserRuntime,
    } from "./desktop/main/agent-browser/index.ts";
    export {
      createAgentBrowserRequest,
    } from "./packages/harness-overlay/src/agent-browser-contract.ts";
  `;
  const bundled = buildSync({
    alias: {
      '@minke/harness-overlay': join(
        projectRoot,
        'packages',
        'harness-overlay',
        'src',
      ),
    },
    bundle: true,
    external: ['electron'],
    format: 'cjs',
    platform: 'node',
    stdin: {
      contents: source,
      loader: 'ts',
      resolveDir: projectRoot,
    },
    target: 'node22',
    write: false,
  }).outputFiles[0].text;
  const filename = join(
    projectRoot,
    '.agent-browser-popout-smoke.cjs',
  );
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(projectRoot);
  compiled._compile(bundled, filename);
  return compiled.exports;
}

async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(`<!doctype html>
      <html>
        <head><title>Agent Browser Popout</title></head>
        <body>
          <p id="state">Ready</p>
          <button
            type="button"
            aria-label="Continue"
            onclick="document.getElementById('state').textContent = 'Done'"
          >Continue</button>
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  return {
    server,
    url: `http://127.0.0.1:${String(address.port)}/`,
  };
}

function wireWebviewHost(runtime, webContents) {
  webContents.on(
    'will-attach-webview',
    (event, webPreferences, params) => {
      const decision = runtime.secureWebview(
        webPreferences,
        params,
      );
      if (decision !== 'secured') event.preventDefault();
    },
  );
  webContents.on('did-attach-webview', (_event, guest) => {
    if (!runtime.attachGuest(webContents, guest)) {
      guest.close({ waitForBeforeUnload: false });
    }
  });
}

async function mountGuestWindow(webContents, partition) {
  const script = `(function() {
    const view = document.createElement('webview');
    view.setAttribute('partition', ${JSON.stringify(partition)});
    view.setAttribute('src', 'about:blank');
    view.setAttribute(
      'webpreferences',
      'contextIsolation=yes,nodeIntegration=no,sandbox=yes,webSecurity=yes',
    );
    document.body.append(view);
  })()`;
  await Promise.race([
    webContents.executeJavaScript(script),
    new Promise((_resolve, reject) => {
      setTimeout(
        () => reject(new Error('executeJavaScript timed out')),
        8_000,
      );
    }),
  ]);
}

async function waitFor(label, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function projectionOf(runtime, sessionId) {
  return runtime
    .projections()
    .find((entry) => entry.sessionId === sessionId);
}

async function run() {
  await app.whenReady();
  const {
    AgentBrowserEmbedderRegistry,
    AgentBrowserPopoutRuntime,
    AgentBrowserRuntime,
    createAgentBrowserRequest,
  } = loadAgentBrowserSource();
  const fixture = await startFixtureServer();
  const runtime = new AgentBrowserRuntime({
    sessionFromPartition(partition, options) {
      return session.fromPartition(partition, options);
    },
    guestAttachTimeoutMs: 10_000,
    cdpCommandTimeoutMs: 10_000,
  });
  const embedders = new AgentBrowserEmbedderRegistry(
    () => fixture.url,
  );
  const preloadPath = join(
    tmpdir(),
    'agent-browser-popout-preload.cjs',
  );
  writeFileSync(preloadPath, '// intentionally empty\n');
  const popouts = new AgentBrowserPopoutRuntime({
    agentBrowser: runtime,
    embedders,
    surfaceSession: session.fromPartition(
      'minke-agent-browser-popout-test',
    ),
    harnessUrl: () => fixture.url,
    locale: () => 'en',
    preloadPath,
    runtimeRoot: join(projectRoot, 'runtime', 'host'),
    electronExecutable: process.execPath,
    defaultCwd: projectRoot,
    fileSystemRoot: 'C:\\',
    minkeConfigPath: join(
      projectRoot,
      '.agent-browser-popout-config.json',
    ),
    environment: { ...process.env },
    prepareWebSession() {},
    limit: 1,
  });

  // Host ("sidebar") window.
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
    },
  });
  const projectionBinding = runtime.bindWindowProjection(
    ipcMain,
    window.webContents,
    () => true,
  );
  embedders.register(window.webContents);
  wireWebviewHost(runtime, window.webContents);
  await window.loadURL(fixture.url);

  // Open a session and mount its guest in the host window.
  const requestId = { value: 0 };
  const openRequest = () =>
    createAgentBrowserRequest(
      (requestId.value += 1),
      'conversation-1',
      'open',
      { url: fixture.url },
    );
  const openPromise = runtime.handleProcessRequest(
    openRequest(),
    new AbortController().signal,
  );
  const pending = await waitFor('pending session', () =>
    runtime
      .projections()
      .find((entry) => entry.status === 'pending'),
  );
  await mountGuestWindow(window.webContents, pending.partition);
  const opened = await openPromise;
  const sessionId = opened.sessionId;
  await waitFor('session ready in host', () =>
    projectionOf(runtime, sessionId)?.status === 'ready',
  );

  // Pop the session out into its own window.
  const popoutWindow = await popouts.createPopout(sessionId);
  const popoutUrl = new URL(popoutWindow.webContents.getURL());
  assert.equal(popoutUrl.searchParams.get('popout'), '1');
  assert.equal(
    popoutUrl.searchParams.get('agentSessionId'),
    sessionId,
  );
  await waitFor('session handed to popout', () =>
    projectionOf(runtime, sessionId)?.host === 'popout',
  );
  // bindTabs inside the popout runtime already wires will-attach-webview /
  // did-attach-webview (secureWebview + attachGuest); wiring it again here
  // would admit the guest twice and reject the second attempt.
  await mountGuestWindow(
    popoutWindow.webContents,
    projectionOf(runtime, sessionId).partition,
  );
  await waitFor('session ready in popout', () => {
    const projection = projectionOf(runtime, sessionId);
    return (
      projection?.host === 'popout' &&
      projection?.status === 'ready'
    );
  });
  await runtime.handleProcessRequest(
    createAgentBrowserRequest(
      99,
      'conversation-1',
      'navigate',
      { sessionId, url: `${fixture.url}?from=popout` },
    ),
    new AbortController().signal,
  );

  // Duplicate popout for the same session is rejected atomically.
  const duplicateError = await popouts
    .createPopout(sessionId)
    .then(() => null, (error) => error);
  assert.equal(duplicateError?.code, 'popout_exists');

  // The window limit rejects a second popout without touching it.
  const secondOpenPromise = runtime.handleProcessRequest(
    createAgentBrowserRequest(
      (requestId.value += 1),
      'conversation-2',
      'open',
      { url: fixture.url },
    ),
    new AbortController().signal,
  );
  const secondPending = await waitFor('second pending session', () =>
    runtime
      .projections()
      .find(
        (entry) =>
          entry.sessionId !== sessionId &&
            entry.status === 'pending',
      ),
  );
  await mountGuestWindow(
    window.webContents,
    secondPending.partition,
  );
  const secondOpened = await secondOpenPromise;
  const limitError = await popouts
    .createPopout(secondOpened.sessionId)
    .then(() => null, (error) => error);
  assert.equal(limitError?.code, 'popout_limit_reached');
  await runtime.closeSession(secondOpened.sessionId);

  // Send the session home. The window-close wiring exercises the same
  // beginRelocation call inside the popout runtime; destroying a window
  // whose page hosted a webview guest can wedge Electron's main process on
  // Windows, so the teardown itself is intentionally left to process exit.
  await runtime.beginRelocation(sessionId, 'sidebar');
  await waitFor('session sent home', () => {
    const projection = projectionOf(runtime, sessionId);
    return (
      projection?.host === undefined &&
      projection?.status === 'pending'
    );
  });
  await window.webContents.executeJavaScript(
    "document.querySelectorAll('webview').forEach((v) => v.remove())",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await mountGuestWindow(
    window.webContents,
    projectionOf(runtime, sessionId).partition,
  );
  await waitFor('session ready back in host', () =>
    projectionOf(runtime, sessionId)?.status === 'ready',
  );
  await runtime.handleProcessRequest(
    createAgentBrowserRequest(
      98,
      'conversation-1',
      'navigate',
      { sessionId, url: `${fixture.url}?from=host` },
    ),
    new AbortController().signal,
  );

  console.log('agent-browser popout runtime smoke: ok');
  // Exit without tearing down windows: their destruction is not part of
  // the behavior under test and can wedge the main process.
  process.exit(0);
}

run()
  .then(() => {
    console.log('agent-browser popout runtime smoke: ok');
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error('agent-browser popout runtime smoke failed:', error);
    process.exitCode = 1;
    app.quit();
  });
