import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebPreferences,
} from "electron";
import { isAbsolute, join } from "node:path";
import { stat } from "node:fs/promises";
import {
  parseTabsLayoutStateUpdate,
  TABS_LAYOUT_STATE_READ_CHANNEL,
  TABS_LAYOUT_STATE_WRITE_CHANNEL,
  TABS_OPEN_EXTERNAL_CHANNEL,
} from "@minke/harness-overlay/tabs/contract.ts";
import {
  TABS_WEB_EXTERNAL_LINK_CHANNEL,
} from "@minke/harness-overlay/tabs/web-link-contract.ts";
import {
  parseFileManagerDiffRequest,
  parseFileManagerListRequest,
  parseFileManagerOpenRequest,
  parseFileManagerPreviewRequest,
  parseFileManagerUnwatchRequest,
  parseFileManagerViewStateUpdate,
  parseFileManagerWatchRequest,
  parseFileManagerWriteRequest,
  TABS_FILES_DIFF_CHANNEL,
  TABS_FILES_CHANGE_CHANNEL,
  TABS_FILES_LIST_CHANNEL,
  TABS_FILES_OPEN_CHANNEL,
  TABS_FILES_PREVIEW_CHANNEL,
  TABS_FILES_UNWATCH_CHANNEL,
  TABS_FILES_VIEW_STATE_READ_CHANNEL,
  TABS_FILES_VIEW_STATE_WRITE_CHANNEL,
  TABS_FILES_WATCH_CHANNEL,
  TABS_FILES_WRITE_CHANNEL,
} from "@minke/harness-overlay/tabs/files-contract.ts";
import {
  parseTerminalCreateRequest,
  parseTerminalResizeRequest,
  parseTerminalSessionId,
  parseTerminalWriteRequest,
  TABS_TERMINAL_CLOSE_CHANNEL,
  TABS_TERMINAL_CREATE_CHANNEL,
  TABS_TERMINAL_EVENT_CHANNEL,
  TABS_TERMINAL_RESIZE_CHANNEL,
  TABS_TERMINAL_WRITE_CHANNEL,
} from "@minke/harness-overlay/tabs/terminal-contract.ts";
import {
  FileManagerRuntime,
} from "./files.ts";
import {
  FileWatchRuntime,
} from "./file-watch.ts";
import {
  FilesViewStateStore,
} from "./files-view-state.ts";
import {
  bindWebTabHistory,
} from "./history.ts";
import {
  TabsLayoutStateStore,
} from "./layout-state.ts";
import {
  openNormalizedTabExternally,
  openUserGestureTabLinkExternally,
  protectTabWebviewGuest,
  secureTabWebview,
} from "./security.ts";
import type {
  AgentBrowserRuntime,
} from "../agent-browser";
import type {
  ExternalPathOpener,
  ExternalTabOpener,
  TabsAuthorization,
  TabsBinding,
} from "./types.ts";
import {
  loadTerminalPty,
  TerminalSessionRuntime,
} from "./terminal.ts";
import {
  environmentValue,
} from "../../../config/embedded-node-runtime.mts";

type TabsIpcMainLike = Pick<
  IpcMain,
  "handle" | "on" | "removeHandler" | "removeListener"
>;

interface TabsRoute {
  readonly authorize: TabsAuthorization;
  readonly invoke: Map<
    string,
    (
      event: IpcMainInvokeEvent,
      payload: unknown,
    ) => unknown
  >;
  readonly listen: Map<
    string,
    (event: IpcMainEvent, payload: unknown) => void
  >;
}

interface TabsIpcHub {
  add(route: TabsRoute): void;
  remove(route: TabsRoute): void;
}

// ipcMain channels are process-global, but every window (main + popouts)
// binds its own Tabs runtime. A hub registers each channel once per ipc
// instance and routes events to the binding whose authorize accepts the
// sender, so additional windows never collide on registration.
const tabsIpcHubs = new WeakMap<TabsIpcMainLike, TabsIpcHub>();

function tabsIpcHub(ipc: TabsIpcMainLike): TabsIpcHub {
  const existing = tabsIpcHubs.get(ipc);
  if (existing !== undefined) return existing;
  const routes = new Set<TabsRoute>();
  const invokeChannels = new Set<string>();
  const listenHandlers = new Map<
    string,
    (event: IpcMainEvent, payload: unknown) => void
  >();
  // Every route authorizes exactly its own window's sender, so routes are
  // disjoint and findRoute is unambiguous; a route matching a foreign
  // sender would silently steal that window's events.
  const findRoute = (
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): TabsRoute | undefined => {
    for (const route of routes) {
      if (route.authorize(event)) return route;
    }
    return undefined;
  };
  const hub: TabsIpcHub = {
    add(route): void {
      routes.add(route);
      for (const channel of route.invoke.keys()) {
        if (invokeChannels.has(channel)) continue;
        invokeChannels.add(channel);
        const handler = async (
          event: IpcMainInvokeEvent,
          payload: unknown,
        ): Promise<unknown> => {
          const target =
            findRoute(event)?.invoke.get(channel);
          if (target === undefined) {
            throw new Error("unauthorized Tabs request");
          }
          return await target(event, payload);
        };
        ipc.handle(channel, handler);
      }
      for (const channel of route.listen.keys()) {
        if (listenHandlers.has(channel)) continue;
        const handler = (
          event: IpcMainEvent,
          payload: unknown,
        ): void => {
          findRoute(event)?.listen.get(channel)?.(
            event,
            payload,
          );
        };
        listenHandlers.set(channel, handler);
        ipc.on(channel, handler);
      }
    },
    remove(route): void {
      routes.delete(route);
      if (routes.size > 0) return;
      for (const channel of invokeChannels) {
        ipc.removeHandler(channel);
      }
      invokeChannels.clear();
      for (const [
        channel,
        handler,
      ] of listenHandlers) {
        ipc.removeListener(channel, handler);
      }
      listenHandlers.clear();
    },
  };
  tabsIpcHubs.set(ipc, hub);
  return hub;
}

interface TabsBindingOptions {
  readonly runtimeRoot: string;
  readonly electronExecutable: string;
  readonly defaultCwd: string;
  readonly fileSystemRoot: string;
  readonly minkeConfigPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly agentBrowser: AgentBrowserRuntime;
  readonly prepareWebSession: () => void;
}

async function resolveTerminalCwd(candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new TypeError("terminal working directory must be absolute");
  }
  const details = await stat(candidate);
  if (!details.isDirectory()) {
    throw new TypeError("terminal working directory must be a directory");
  }
  return candidate;
}

export function defaultTerminalShell(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): {
  shell: string;
  args: readonly string[];
} {
  if (platform === "win32") {
    return {
      shell:
        environmentValue(environment, "COMSPEC") ??
        "cmd.exe",
      args: [],
    };
  }
  return {
    shell:
      environmentValue(environment, "SHELL") ??
      (platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
    args: ["-l"],
  };
}

/**
 * Bind the trusted main-process half of the Web tab adapter.
 * Renderer requests are accepted only from the active Harness document.
 */
export function bindTabs(
  ipc: Pick<
    IpcMain,
    "handle" | "on" | "removeHandler" | "removeListener"
  >,
  embedder: WebContents,
  external: ExternalTabOpener & ExternalPathOpener,
  authorize: TabsAuthorization,
  options: TabsBindingOptions,
): TabsBinding {
  const terminalShell = defaultTerminalShell(
    options.environment,
  );
  const terminal = new TerminalSessionRuntime({
    pty: loadTerminalPty(options.runtimeRoot),
    shell: terminalShell.shell,
    shellArgs: terminalShell.args,
    runtimeRoot: options.runtimeRoot,
    electronExecutable: options.electronExecutable,
    defaultCwd: options.defaultCwd,
    environment: options.environment,
    resolveCwd: resolveTerminalCwd,
    send: (event) => {
      if (!embedder.isDestroyed()) {
        embedder.send(TABS_TERMINAL_EVENT_CHANNEL, event);
      }
    },
  });
  const files = new FileManagerRuntime({
    rootPath: options.fileSystemRoot,
    allowCrossVolumeAccess: true,
    openPath: (path) => external.openPath(path),
  });
  const filesViewState = new FilesViewStateStore(
    options.minkeConfigPath,
  );
  const tabsLayoutState = new TabsLayoutStateStore(
    options.minkeConfigPath,
  );
  const fileWatch = new FileWatchRuntime({
    send: (event) => {
      if (!embedder.isDestroyed()) {
        embedder.send(TABS_FILES_CHANGE_CHANNEL, event);
      }
    },
  });
  const attachedWebGuests = new Set<WebContents>();
  const webGuestHistoryBindings =
    new Map<WebContents, () => void>();
  const agentBrowserProjection =
    options.agentBrowser.bindWindowProjection(
      ipc,
      embedder,
      authorize,
    );
  const handleWillAttach = (
    event: Electron.Event,
    webPreferences: WebPreferences,
    params: Record<string, string>,
  ): void => {
    const agentBrowserDecision =
      options.agentBrowser.secureWebview(
        webPreferences,
        params,
      );
    if (agentBrowserDecision === "secured") return;
    if (agentBrowserDecision === "rejected") {
      event.preventDefault();
      return;
    }
    const secured = secureTabWebview(
      webPreferences,
      params,
      join(__dirname, "tabs-web-preload.js"),
    );
    if (!secured) {
      event.preventDefault();
      return;
    }
    options.prepareWebSession();
  };
  const handleDidAttach = (
    _event: Electron.Event,
    guest: WebContents,
  ): void => {
    if (options.agentBrowser.attachGuest(embedder, guest)) {
      return;
    }
    attachedWebGuests.add(guest);
    const disposeHistory = bindWebTabHistory(
      guest,
      options.agentBrowser,
    );
    const handleDestroyed = (): void => {
      attachedWebGuests.delete(guest);
      webGuestHistoryBindings.delete(guest);
      disposeHistory();
    };
    webGuestHistoryBindings.set(guest, () => {
      guest.removeListener("destroyed", handleDestroyed);
      disposeHistory();
    });
    guest.once("destroyed", handleDestroyed);
    protectTabWebviewGuest(guest, external);
  };
  const handleGuestExternalLink = (
    event: IpcMainEvent,
    candidate: unknown,
  ): void => {
    if (!attachedWebGuests.has(event.sender)) return;
    openUserGestureTabLinkExternally(external, candidate);
  };
  const handleOpenExternal = (
    event: IpcMainEvent,
    candidate: unknown,
  ): void => {
    if (!authorize(event)) return;
    openNormalizedTabExternally(external, candidate);
  };
  const handleTabsLayoutStateRead = async (
    event: IpcMainInvokeEvent,
  ): Promise<unknown> => {
    if (!authorize(event)) {
      throw new Error("unauthorized Tabs request");
    }
    return await tabsLayoutState.read();
  };
  const handleTabsLayoutStateWrite = async (
    event: IpcMainInvokeEvent,
    update: unknown,
  ): Promise<void> => {
    if (!authorize(event)) {
      throw new Error("unauthorized Tabs request");
    }
    await tabsLayoutState.write(
      parseTabsLayoutStateUpdate(update),
    );
  };
  const handleTerminalCreate = async (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Promise<unknown> => {
    if (!authorize(event)) {
      throw new Error("unauthorized Terminal request");
    }
    return await terminal.create(
      parseTerminalCreateRequest(request),
    );
  };
  const handleTerminalWrite = (
    event: IpcMainEvent,
    request: unknown,
  ): void => {
    if (!authorize(event)) return;
    try {
      terminal.write(parseTerminalWriteRequest(request));
    } catch {
      // Invalid high-frequency input is ignored at the trusted boundary.
    }
  };
  const handleTerminalResize = (
    event: IpcMainEvent,
    request: unknown,
  ): void => {
    if (!authorize(event)) return;
    try {
      terminal.resize(parseTerminalResizeRequest(request));
    } catch {
      // Invalid resize traffic is ignored at the trusted boundary.
    }
  };
  const handleTerminalClose = (
    event: IpcMainEvent,
    sessionId: unknown,
  ): void => {
    if (!authorize(event)) return;
    try {
      terminal.close(parseTerminalSessionId(sessionId));
    } catch {
      // Invalid close traffic is ignored at the trusted boundary.
    }
  };
  const handleFilesList = async (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Promise<unknown> => {
    if (!authorize(event)) {
      throw new Error("unauthorized Files request");
    }
    return await files.list(
      parseFileManagerListRequest(request),
    );
  };
  const handleFilesDiff = async (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Promise<unknown> => {
    if (!authorize(event)) {
      throw new Error("unauthorized Files request");
    }
    return await files.diff(
      parseFileManagerDiffRequest(request),
    );
  };
  const handleFilesOpen = async (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Promise<void> => {
    if (!authorize(event)) {
      throw new Error("unauthorized Files request");
    }
    await files.open(parseFileManagerOpenRequest(request));
  };
  const handleFilesPreview = async (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Promise<unknown> => {
    if (!authorize(event)) {
      throw new Error("unauthorized Files request");
    }
    return await files.preview(
      parseFileManagerPreviewRequest(request),
    );
  };
  const handleFilesWrite = async (
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Promise<unknown> => {
    if (!authorize(event)) {
      throw new Error("unauthorized Files request");
    }
    return await files.write(
      parseFileManagerWriteRequest(request),
    );
  };
  const handleFilesViewStateRead = async (
    event: IpcMainInvokeEvent,
  ): Promise<unknown> => {
    if (!authorize(event)) {
      throw new Error("unauthorized Files request");
    }
    return await filesViewState.read();
  };
  const handleFilesViewStateWrite = async (
    event: IpcMainInvokeEvent,
    update: unknown,
  ): Promise<void> => {
    if (!authorize(event)) {
      throw new Error("unauthorized Files request");
    }
    await filesViewState.write(
      parseFileManagerViewStateUpdate(update),
    );
  };
  const handleFilesWatch = (
    event: IpcMainEvent,
    request: unknown,
  ): void => {
    if (!authorize(event)) return;
    try {
      fileWatch.watch(parseFileManagerWatchRequest(request));
    } catch {
      // Invalid or unavailable watch targets do not affect other Files tabs.
    }
  };
  const handleFilesUnwatch = (
    event: IpcMainEvent,
    request: unknown,
  ): void => {
    if (!authorize(event)) return;
    try {
      fileWatch.unwatch(parseFileManagerUnwatchRequest(request));
    } catch {
      // Invalid watcher ids cannot own a main-process filesystem watcher.
    }
  };

  const route: TabsRoute = {
    authorize,
    invoke: new Map([
      [
        TABS_LAYOUT_STATE_READ_CHANNEL,
        handleTabsLayoutStateRead,
      ],
      [
        TABS_LAYOUT_STATE_WRITE_CHANNEL,
        handleTabsLayoutStateWrite,
      ],
      [TABS_TERMINAL_CREATE_CHANNEL, handleTerminalCreate],
      [TABS_FILES_LIST_CHANNEL, handleFilesList],
      [TABS_FILES_DIFF_CHANNEL, handleFilesDiff],
      [TABS_FILES_OPEN_CHANNEL, handleFilesOpen],
      [TABS_FILES_PREVIEW_CHANNEL, handleFilesPreview],
      [TABS_FILES_WRITE_CHANNEL, handleFilesWrite],
      [
        TABS_FILES_VIEW_STATE_READ_CHANNEL,
        handleFilesViewStateRead,
      ],
      [
        TABS_FILES_VIEW_STATE_WRITE_CHANNEL,
        handleFilesViewStateWrite,
      ],
    ]),
    listen: new Map([
      [TABS_OPEN_EXTERNAL_CHANNEL, handleOpenExternal],
      [
        TABS_WEB_EXTERNAL_LINK_CHANNEL,
        handleGuestExternalLink,
      ],
      [TABS_TERMINAL_WRITE_CHANNEL, handleTerminalWrite],
      [TABS_TERMINAL_RESIZE_CHANNEL, handleTerminalResize],
      [TABS_TERMINAL_CLOSE_CHANNEL, handleTerminalClose],
      [TABS_FILES_WATCH_CHANNEL, handleFilesWatch],
      [TABS_FILES_UNWATCH_CHANNEL, handleFilesUnwatch],
    ]),
  };
  tabsIpcHub(ipc).add(route);

  embedder.on("will-attach-webview", handleWillAttach);
  embedder.on("did-attach-webview", handleDidAttach);

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      embedder.removeListener("will-attach-webview", handleWillAttach);
      embedder.removeListener("did-attach-webview", handleDidAttach);
      tabsIpcHub(ipc).remove(route);
      for (const disposeHistory of webGuestHistoryBindings.values()) {
        disposeHistory();
      }
      webGuestHistoryBindings.clear();
      attachedWebGuests.clear();
      agentBrowserProjection.dispose();
      fileWatch.dispose();
      void terminal.dispose();
    },
  };
}
