import {
  BrowserWindow,
  ipcMain,
  shell,
  type IpcMainEvent,
  type Session,
  type WebContents,
} from "electron";
import {
  AGENT_BROWSER_POPOUT_CLOSE_CHANNEL,
  AGENT_BROWSER_POPOUT_OPEN_CHANNEL,
  parseAgentBrowserPopoutRequest,
} from "@minke/harness-overlay/agent-browser-contract.ts";
import { AgentBrowserError } from "./cdp.ts";
import type {
  AgentBrowserRuntime,
} from "./runtime.ts";
import type {
  AgentBrowserEmbedderRegistry,
} from "./embedder-registry.ts";
import {
  bindTabs,
  type TabsBinding,
} from "../tabs";
import {
  canOpenExternally,
  isInternalNavigation,
} from "../navigation-policy";
import {
  macOSWindowOptions,
} from "../macos-window";

const MAX_AGENT_BROWSER_POPOUTS = 8;
const BACKGROUND_COLOR = "#0b1220";

export interface AgentBrowserPopoutRuntimeOptions {
  agentBrowser: AgentBrowserRuntime;
  /** Registry of windows allowed to reach Agent Browser channels. */
  embedders: AgentBrowserEmbedderRegistry;
  surfaceSession: Session;
  harnessUrl(): string | undefined;
  locale(): string;
  preloadPath: string;
  runtimeRoot: string;
  electronExecutable: string;
  defaultCwd: string;
  fileSystemRoot: string;
  minkeConfigPath: string;
  /** Resolved lazily: the DSH environment may not exist at app start. */
  environment(): NodeJS.ProcessEnv;
  prepareWebSession(): void;
  /** Test seam; production uses MAX_AGENT_BROWSER_POPOUTS. */
  readonly limit?: number;
}

interface AgentBrowserPopoutEntry {
  readonly window: BrowserWindow;
  readonly sessionId: string;
  readonly tabsBinding: TabsBinding;
}

/**
 * Owns the independent Agent Browser windows (popouts).
 *
 * Each popout loads the same harness client as the main window, wired with
 * the full tabs binding (webview attach channel included) but authorized
 * through the shared embedder registry. Session continuity across windows
 * is delegated to the runtime's relocation lifecycle: creation starts a
 * relocation to "popout" (detaching the sidebar guest), window close sends
 * the session home.
 */
export class AgentBrowserPopoutRuntime {
  readonly #options: AgentBrowserPopoutRuntimeOptions;
  readonly #popouts = new Map<WebContents, AgentBrowserPopoutEntry>();
  readonly #reservations = new Set<string>();
  #popoutCloseHandler:
    | ((event: IpcMainEvent) => void)
    | undefined;
  #disposed = false;

  constructor(options: AgentBrowserPopoutRuntimeOptions) {
    this.#options = options;
    ipcMain.handle(
      AGENT_BROWSER_POPOUT_OPEN_CHANNEL,
      async (event, value: unknown) => {
        if (!this.#options.embedders.authorize(event)) {
          throw new AgentBrowserError(
            "unauthorized",
            "unauthorized Agent Browser popout request",
          );
        }
        const request = parseAgentBrowserPopoutRequest(value);
        await this.createPopout(request.sessionId);
        return { opened: true as const };
      },
    );
    this.#popoutCloseHandler = (event: IpcMainEvent): void => {
      if (!this.#options.embedders.authorize(event)) return;
      const entry = this.#popouts.get(event.sender);
      if (entry === undefined) return;
      entry.window.close();
    };
    ipcMain.on(
      AGENT_BROWSER_POPOUT_CLOSE_CHANNEL,
      this.#popoutCloseHandler,
    );
  }

  /** How many popout windows may exist at once. */
  get limit(): number {
    return this.#options.limit ?? MAX_AGENT_BROWSER_POPOUTS;
  }

  /**
   * Pop a session out into its own window.
   *
   * The reservation, duplicate check, and limit check complete without an
   * intervening await, so concurrent open requests cannot race; the
   * relocation detaches the sidebar guest before the window loads the
   * client, which then mounts the blank guest for this partition.
   */
  async createPopout(sessionId: string): Promise<BrowserWindow> {
    if (this.#disposed) {
      throw new AgentBrowserError(
        "runtime_closed",
        "Agent Browser popout runtime is closed",
      );
    }
    if (this.#options.harnessUrl() === undefined) {
      throw new AgentBrowserError(
        "popout_unavailable",
        "Agent Browser popout requires the harness runtime",
      );
    }
    if (
      this.#reservations.has(sessionId) ||
      [...this.#popouts.values()].some(
        (entry) => entry.sessionId === sessionId,
      )
    ) {
      throw new AgentBrowserError(
        "popout_exists",
        "Agent Browser session is already popped out",
      );
    }
    if (
      this.#popouts.size + this.#reservations.size >=
      this.limit
    ) {
      throw new AgentBrowserError(
        "popout_limit_reached",
        `Agent Browser popout window limit (${String(this.limit)}) reached`,
      );
    }
    this.#reservations.add(sessionId);
    let window: BrowserWindow | undefined;
    try {
      await this.#options.agentBrowser.beginRelocation(
        sessionId,
        "popout",
      );
      window = await this.#createWindow(sessionId);
      return window;
    } catch (error) {
      if (
        window !== undefined &&
        !window.isDestroyed()
      ) {
        window.destroy();
      }
      void this.#options.agentBrowser
        .beginRelocation(sessionId, "sidebar")
        .catch(() => {
          // The session may already be closed; nothing to send home.
        });
      throw error;
    } finally {
      this.#reservations.delete(sessionId);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    ipcMain.removeHandler(AGENT_BROWSER_POPOUT_OPEN_CHANNEL);
    if (this.#popoutCloseHandler !== undefined) {
      ipcMain.removeListener(
        AGENT_BROWSER_POPOUT_CLOSE_CHANNEL,
        this.#popoutCloseHandler,
      );
      this.#popoutCloseHandler = undefined;
    }
    for (const entry of [...this.#popouts.values()]) {
      this.#releasePopout(
        entry.window.webContents,
        entry.tabsBinding,
      );
      if (!entry.window.isDestroyed()) {
        entry.window.destroy();
      }
    }
    this.#popouts.clear();
  }

  async #createWindow(
    sessionId: string,
  ): Promise<BrowserWindow> {
    const window = new BrowserWindow({
      title: "Minke Agent Browser",
      width: 960,
      height: 720,
      minWidth: 640,
      minHeight: 480,
      show: false,
      backgroundColor: BACKGROUND_COLOR,
      ...macOSWindowOptions(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: this.#options.preloadPath,
        sandbox: true,
        session: this.#options.surfaceSession,
        webSecurity: true,
        webviewTag: true,
      },
    });
    const contents = window.webContents;
    this.#options.embedders.register(contents);
    let tabsBinding: TabsBinding;
    try {
      tabsBinding = bindTabs(
        ipcMain,
        contents,
        shell,
        (candidate) => this.#options.embedders.authorize(candidate),
        {
          runtimeRoot: this.#options.runtimeRoot,
          electronExecutable: this.#options.electronExecutable,
          defaultCwd: this.#options.defaultCwd,
          fileSystemRoot: this.#options.fileSystemRoot,
          minkeConfigPath: this.#options.minkeConfigPath,
          environment: this.#options.environment(),
          agentBrowser: this.#options.agentBrowser,
          prepareWebSession: () =>
            this.#options.prepareWebSession(),
        },
      );
    } catch (error) {
      // Without this guard the window leaks: createPopout's catch only
      // sees `window === undefined` because #createWindow never returned.
      this.#options.embedders.unregister(contents);
      window.destroy();
      throw error;
    }
    this.#popouts.set(contents, {
      window,
      sessionId,
      tabsBinding,
    });
    this.#protectNavigation(window);
    // Intercept close: detach the guest through the runtime's relocation
    // lifecycle (releasing the debugger) before the window tears down its
    // renderer; destroying a window that still hosts a debugged guest can
    // block the main process.
    let closing = false;
    window.on("close", (event) => {
      if (closing) return;
      closing = true;
      event.preventDefault();
      void this.#options.agentBrowser
        .beginRelocation(sessionId, "sidebar")
        .catch(() => {
          // The session may already be closed; nothing to send home.
        })
        .then(() => {
          this.#releasePopout(contents, tabsBinding);
          if (!window.isDestroyed()) {
            window.destroy();
          }
        });
    });
    window.once("closed", () => {
      this.#releasePopout(contents, tabsBinding);
    });
    window.once("ready-to-show", () => window.show());
    await this.#loadPopoutPage(window, sessionId);
    return window;
  }

  /**
   * Release a popout exactly once, keyed by the contents captured while
   * the window was alive: the `closed` event fires after destruction,
   * where `window.webContents` would already throw.
   */
  #releasePopout(
    contents: WebContents,
    tabsBinding: TabsBinding,
  ): void {
    if (!this.#popouts.delete(contents)) return;
    this.#options.embedders.unregister(contents);
    tabsBinding.dispose();
  }

  async #loadPopoutPage(
    window: BrowserWindow,
    sessionId: string,
  ): Promise<void> {
    const harnessUrl = this.#options.harnessUrl();
    if (harnessUrl === undefined) {
      throw new AgentBrowserError(
        "popout_unavailable",
        "Agent Browser popout requires the harness runtime",
      );
    }
    const url = new URL(harnessUrl);
    url.searchParams.set("popout", "1");
    url.searchParams.set("agentSessionId", sessionId);
    url.searchParams.set("locale", this.#options.locale());
    await window.loadURL(url.toString());
  }

  #protectNavigation(window: BrowserWindow): void {
    window.webContents.on("will-navigate", (details) => {
      if (
        isInternalNavigation(details.url, [
          this.#options.harnessUrl(),
        ])
      ) {
        return;
      }
      details.preventDefault();
      if (canOpenExternally(details.url)) {
        void shell.openExternal(details.url);
      }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (canOpenExternally(url)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });
  }
}
