import type { App } from "electron";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Development data directory kept below the project root. */
const DEV_DATA_DIR = ".devdata";
/** Directory beside a packaged executable that holds portable storage. */
const PORTABLE_DIR = "data";
/** Electron userData/sessionData directory name. */
const MINKE_SUBDIR = "minke";
/** DSH home directory name. */
const DSH_SUBDIR = "dsh";
/** Fallback Electron data home under the user directory. */
const HOME_MINKE_DIR = ".minke";

/**
 * Resolve the portable data directory sitting next to a packaged executable,
 * creating it automatically when missing. Returns undefined (so the caller
 * falls back to the user's home) when a non-directory occupies the path or the
 * location is read-only (e.g. Program Files).
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
  /** DSH home to export, or undefined to leave DSH resolution untouched. */
  dshHome: string | undefined;
}

/**
 * Choose where durable state lives:
 * - development: everything below `<projectRoot>/.devdata`, self-contained;
 * - packaged, writable exe directory: portable `data` folder beside the binary;
 * - packaged but unwritable: the user's `~/.minke` fallback.
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
  return {
    userDataPath: join(app.getPath("home"), HOME_MINKE_DIR),
    dshHome: undefined,
  };
}

/**
 * Pin all durable Electron data (and the DSH home default) to the resolved
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
  if (layout.dshHome === undefined) return;
  // An explicitly exported DSH_HOME still wins; this only fills the default.
  if (
    process.env.DSH_HOME === undefined ||
    process.env.DSH_HOME.trim() === ""
  ) {
    mkdirSync(layout.dshHome, { recursive: true, mode: 0o700 });
    process.env.DSH_HOME = layout.dshHome;
  }
}
