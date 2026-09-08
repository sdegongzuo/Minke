import type { App } from "electron";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setEnvironmentName } from "../../config/embedded-node-runtime.mts";

/** Development data directory kept below the project root. */
const DEV_DATA_DIR = ".devdata";
/** Directory beside a packaged executable that holds portable storage. */
const PORTABLE_DIR = "data";
/** Electron userData/sessionData directory name. */
const MINKE_SUBDIR = "minke";
/** DSH home directory name. */
const DSH_SUBDIR = "dsh";

/**
 * Resolve the portable data directory sitting next to a packaged executable,
 * creating it automatically when missing. Returns undefined when a
 * non-directory occupies the path or the location is read-only.
 */
export function portableRootForExecutable(
  execPath: string,
): string | undefined {
  const candidate = join(dirname(execPath), PORTABLE_DIR);
  try {
    mkdirSync(candidate, { recursive: true });
    return statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

interface DataLayout {
  /** Directory assigned to Electron userData/sessionData. */
  userDataPath: string;
  /** Private DSH home exported before any state is loaded. */
  dshHome: string;
}

/**
 * Choose where durable state lives:
 * - development: everything below `<projectRoot>/.devdata`, self-contained;
 * - packaged, writable exe directory: portable `data` folder beside the binary;
 * - packaged but unwritable: stop instead of sharing a user's Harness data.
 */
function resolveDataLayout(
  app: Pick<App, "getAppPath" | "getPath" | "isPackaged">,
  execPath: string,
): DataLayout {
  if (!app.isPackaged) {
    const devRoot = join(app.getAppPath(), DEV_DATA_DIR);
    return {
      userDataPath: join(devRoot, MINKE_SUBDIR),
      dshHome: join(devRoot, DSH_SUBDIR),
    };
  }
  const portableRoot = portableRootForExecutable(execPath);
  if (portableRoot !== undefined) {
    return {
      userDataPath: join(portableRoot, MINKE_SUBDIR),
      dshHome: join(portableRoot, DSH_SUBDIR),
    };
  }
  throw new Error(
    `Cannot create portable data directory beside ${execPath}. Install Minke in a writable directory.`,
  );
}

/**
 * Pin Electron storage and the initial DSH home to the resolved
 * layout before the application acquires any durable state.
 */
export function configureAppDataPaths(
  app: Pick<
    App,
    "getAppPath" | "getPath" | "isPackaged" | "setPath"
  >,
  options: { execPath?: string } = {},
): void {
  const execPath = options.execPath ?? process.execPath;
  const layout = resolveDataLayout(app, execPath);
  mkdirSync(layout.userDataPath, { recursive: true, mode: 0o700 });
  app.setPath("userData", layout.userDataPath);
  app.setPath("sessionData", layout.userDataPath);
  mkdirSync(layout.dshHome, { recursive: true, mode: 0o700 });
  // The launching shell may belong to a standalone DSH installation.
  // Only this process is changed; the shell and other Harness processes keep theirs.
  setEnvironmentName(process.env, "DSH_HOME", layout.dshHome);
}
