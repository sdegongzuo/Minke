import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  WebviewTag,
} from "electron";
import {
  parseAgentBrowserProjections,
  type AgentBrowserProjection,
} from "@minke/harness-overlay/agent-browser-contract.ts";
import {
  desktopAgentBrowserPort,
} from "@minke/harness-overlay/client/desktop/workspace.ts";
import type {
  HarnessClientContext,
} from "@minke/harness-overlay/client/core/context.ts";
import {
  configureAgentBrowserWebview,
} from "./webview.ts";
import {
  AgentCursorOverlay,
} from "./AgentCursorOverlay.tsx";
import {
  installAgentBrowserTabStyles,
} from "./styles.ts";
import {
  agentBrowserTabsEn,
  agentBrowserTabsZh,
  type AgentBrowserTabsLocaleKey,
  type AgentBrowserTabsTranslate,
} from "./locales.ts";

const AGENT_BROWSER_TABS_NAMESPACE = "minke.agentBrowserTabs";
const POPOUT_QUERY_PARAM = "popout";
const POPOUT_SESSION_QUERY_PARAM = "agentSessionId";

export function isAgentBrowserPopoutLocation(): boolean {
  try {
    return new URL(window.location.href).searchParams.get(
      POPOUT_QUERY_PARAM,
    ) === "1";
  } catch {
    return false;
  }
}

function popoutSessionIdFromLocation(): string | undefined {
  try {
    const sessionId = new URL(window.location.href).searchParams.get(
      POPOUT_SESSION_QUERY_PARAM,
    );
    return sessionId === null || sessionId === ""
      ? undefined
      : sessionId;
  } catch {
    return undefined;
  }
}

/**
 * Standalone Agent Browser view for a dedicated popout window.
 *
 * Mounts the single session's guest webview only while the runtime reports
 * `host: "popout"`; the guest starts blank and the runtime drives the
 * reload-to-current-URL after attach, so no navigation state lives here.
 */
function AgentBrowserPopoutView({
  sessionId,
  t,
}: {
  readonly sessionId: string;
  readonly t: AgentBrowserTabsTranslate;
}): ReactNode {
  const port = desktopAgentBrowserPort();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [projection, setProjection] = useState<
    AgentBrowserProjection | undefined
  >(undefined);

  useEffect(() => {
    let disposed = false;
    const apply = (value: unknown): void => {
      if (disposed) return;
      try {
        const projections = parseAgentBrowserProjections(value);
        setProjection(
          projections.find(
            (candidate) => candidate.sessionId === sessionId,
          ),
        );
      } catch {
        // Only validated main-process projections are rendered.
      }
    };
    const unsubscribe = port.subscribe(apply);
    void port
      .read()
      .then(apply)
      .catch(() => {
        // A later main-process projection hydrates the view.
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [port, sessionId]);

  const hosted = projection?.host === "popout";
  const partition = projection?.partition;
  const titleRef = useRef(sessionId);
  titleRef.current = projection?.title ?? sessionId;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    // Mount only on host/partition transitions: remounting on every
    // projection broadcast would destroy the attached guest (the runtime
    // treats an unexpected guest destroy as a crash).
    if (!hosted || partition === undefined) return;
    const view = host.ownerDocument.createElement(
      "webview",
    ) as WebviewTag;
    configureAgentBrowserWebview(view, {
      partition,
      label: titleRef.current,
    });
    host.append(view);
    return () => {
      view.remove();
    };
  }, [hosted, partition, sessionId]);

  if (projection === undefined) {
    return (
      <div
        className="minke-agent-browser__popout"
        data-state="missing"
      >
        <div className="minke-agent-browser__shield">
          <div className="minke-agent-browser__shield-card">
            <span>{t("agentBrowser.state.pending")}</span>
          </div>
        </div>
      </div>
    );
  }

  const crashed = projection.status === "crashed";
  const shielded =
    crashed ||
    projection.owner === "agent" ||
    !hosted;
  const agentActive =
    projection.owner === "agent" &&
    projection.status === "ready";

  return (
    <div
      className="minke-agent-browser__popout"
      data-owner={projection.owner}
      data-status={projection.status}
      data-hosted={hosted || undefined}
    >
      <div className="minke-agent-browser__popout-bar">
        <span
          className="minke-agent-browser__url"
          title={projection.url}
        >
          {projection.url ?? t("agentBrowser.tab.defaultTitle")}
        </span>
        <button
          type="button"
          onClick={() => port.closePopout()}
        >
          {t("agentBrowser.popout.action.close")}
        </button>
      </div>
      <div className="minke-agent-browser__view">
        <div ref={hostRef} hidden={!hosted} />
        {shielded && (
          <div
            className="minke-agent-browser__shield"
            role="status"
            onContextMenu={(event) => event.preventDefault()}
            onWheel={(event) => event.preventDefault()}
          >
            <div className="minke-agent-browser__shield-card">
              <span>
                {crashed
                  ? t("agentBrowser.state.crashed")
                  : !hosted
                    ? t("agentBrowser.popout.state.relocated")
                    : projection.owner === "agent"
                      ? t("agentBrowser.state.agent")
                      : t("agentBrowser.state.pending")}
              </span>
              {!crashed &&
                projection.owner === "agent" && (
                <button
                  type="button"
                  onClick={() => {
                    void port
                      .setControl(sessionId, "human")
                      .catch(() => {
                        // The next projection reports the race.
                      });
                  }}
                >
                  {t("agentBrowser.action.takeControl")}
                </button>
              )}
              {(projection.error ?? undefined) !== undefined && (
                <small>{projection.error}</small>
              )}
            </div>
          </div>
        )}
        {agentActive && projection.cursor !== undefined && (
          <AgentCursorOverlay cursor={projection.cursor} />
        )}
      </div>
    </div>
  );
}

/**
 * Detect the popout URL and, when present, mount the standalone view
 * instead of the full harness UI. Returns true when the page is a popout.
 */
export function installAgentBrowserPopout(
  ctx: HarnessClientContext,
): boolean {
  if (!isAgentBrowserPopoutLocation()) return false;
  const sessionId = popoutSessionIdFromLocation();
  if (sessionId === undefined) return false;

  ctx.effect(
    () =>
      ctx.locale.register(AGENT_BROWSER_TABS_NAMESPACE, {
        zh: agentBrowserTabsZh,
        en: agentBrowserTabsEn,
      }),
    "minke-overlay: Agent Browser popout dictionaries",
  );
  const t = ctx.locale.bind<AgentBrowserTabsLocaleKey>(
    AGENT_BROWSER_TABS_NAMESPACE,
  ) as AgentBrowserTabsTranslate;
  ctx.effect(
    () => installAgentBrowserTabStyles(),
    "minke-overlay: Agent Browser popout styles",
  );
  ctx.effect(
    () => {
      const host = document.createElement("div");
      host.className = "minke-agent-browser__popout-root";
      document.body.append(host);
      const root = createRoot(host);
      root.render(
        <AgentBrowserPopoutView sessionId={sessionId} t={t} />,
      );
      return () => {
        root.unmount();
        host.remove();
      };
    },
    "minke-overlay: Agent Browser popout view",
  );
  return true;
}
