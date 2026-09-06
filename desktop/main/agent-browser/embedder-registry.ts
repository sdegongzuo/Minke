import type {
  IpcMainEvent,
  WebContents,
} from "electron";

type EmbedderCandidate = Pick<
  IpcMainEvent,
  "sender" | "senderFrame"
>;

/**
 * Shared sender allowlist for every window allowed to talk to the Agent
 * Browser projection channels.
 *
 * Entries are added and removed only by the main process when it creates or
 * destroys a window; renderer traffic can never grow the set. Authorization
 * still requires the sender frame to sit on the harness origin, so a
 * registered window navigating away loses access.
 */
export class AgentBrowserEmbedderRegistry {
  readonly #harnessUrl: () => string | undefined;
  readonly #embedders = new Set<WebContents>();

  constructor(harnessUrl: () => string | undefined) {
    this.#harnessUrl = harnessUrl;
  }

  register(embedder: WebContents): void {
    this.#embedders.add(embedder);
  }

  unregister(embedder: WebContents): void {
    this.#embedders.delete(embedder);
  }

  authorize(candidate: EmbedderCandidate): boolean {
    return (
      this.#embedders.has(candidate.sender) &&
      candidate.senderFrame !== null &&
      this.#isHarnessUrl(candidate.senderFrame.url)
    );
  }

  #isHarnessUrl(value: string): boolean {
    const harnessUrl = this.#harnessUrl();
    if (harnessUrl === undefined) return false;
    try {
      return new URL(value).origin === new URL(harnessUrl).origin;
    } catch {
      return false;
    }
  }
}
