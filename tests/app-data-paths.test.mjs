import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureAppDataPaths,
  portableRootForExecutable,
} from "@minke/desktop/main/app-data-paths.ts";
import {
  prepareDesktopApplication,
} from "@minke/desktop/main/application-entry.ts";

function devApp(projectRoot, setPath, getPath) {
  return {
    isPackaged: false,
    getAppPath: () => projectRoot,
    getPath: getPath ?? (() => {
      throw new Error("development layout must not read the home directory");
    }),
    setPath,
  };
}

test("development keeps all data below the project root .devdata", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "minke-project-"));
  const calls = [];
  const previousDshHome = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    configureAppDataPaths(
      devApp(projectRoot, (name, path) => calls.push([name, path])),
    );

    assert.deepEqual(calls, [
      ["userData", join(projectRoot, ".devdata", "minke")],
      ["sessionData", join(projectRoot, ".devdata", "minke")],
    ]);
    assert.equal(
      process.env.DSH_HOME,
      join(projectRoot, ".devdata", "dsh"),
    );
    await stat(join(projectRoot, ".devdata", "minke"));
    await stat(join(projectRoot, ".devdata", "dsh"));
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("desktop configures data paths before claiming the process", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "minke-entry-"));
  const calls = [];
  try {
    assert.equal(
      prepareDesktopApplication({
        isPackaged: false,
        getAppPath: () => projectRoot,
        setName(name) {
          calls.push(["name", name]);
        },
        getPath() {
          throw new Error("development layout must not read the home");
        },
        setPath(name, path) {
          calls.push(["setPath", name, path]);
        },
        requestSingleInstanceLock() {
          calls.push(["lock"]);
          return true;
        },
        quit() {
          calls.push(["quit"]);
        },
      }),
      true,
    );
    assert.deepEqual(calls, [
      ["name", "Minke"],
      ["setPath", "userData", join(projectRoot, ".devdata", "minke")],
      ["setPath", "sessionData", join(projectRoot, ".devdata", "minke")],
      ["lock"],
    ]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a duplicate desktop process yields the single-instance claim", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "minke-entry-"));
  let quitCalls = 0;
  try {
    assert.equal(
      prepareDesktopApplication({
        isPackaged: false,
        getAppPath: () => projectRoot,
        setName() {},
        getPath() {},
        setPath() {},
        requestSingleInstanceLock: () => false,
        quit() {
          quitCalls += 1;
        },
      }),
      false,
    );
    assert.equal(quitCalls, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("portable root is auto-created beside the executable", async () => {
  const exeDir = await mkdtemp(join(tmpdir(), "minke-portable-"));
  try {
    const exePath = join(exeDir, "Minke.exe");
    const expected = join(exeDir, "data");
    // Missing: created automatically and returned.
    assert.equal(portableRootForExecutable(exePath), expected);
    assert.equal((await stat(expected)).isDirectory(), true);
    // Already exists: idempotent, same result.
    assert.equal(portableRootForExecutable(exePath), expected);
    // A regular file occupying the path does not enable portable mode.
    await rm(expected, { recursive: true, force: true });
    await writeFile(expected, "not-a-directory");
    assert.equal(portableRootForExecutable(exePath), undefined);
  } finally {
    await rm(exeDir, { recursive: true, force: true });
  }
});

test("packaged app auto-creates portable storage beside the binary", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "minke-home-"));
  const exeDir = await mkdtemp(join(tmpdir(), "minke-exe-"));
  const calls = [];
  const previousDshHome = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    configureAppDataPaths(
      {
        isPackaged: true,
        getAppPath: () => {
          throw new Error("packaged layout must not use the app path");
        },
        getPath: () => homePath,
        setPath(name, path) {
          calls.push([name, path]);
        },
      },
      { execPath: join(exeDir, "Minke.exe") },
    );

    const portableRoot = join(exeDir, "data");
    assert.deepEqual(calls, [
      ["userData", join(portableRoot, "minke")],
      ["sessionData", join(portableRoot, "minke")],
    ]);
    assert.equal(process.env.DSH_HOME, join(portableRoot, "dsh"));
    await stat(join(portableRoot, "minke"));
    await stat(join(portableRoot, "dsh"));
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    await rm(homePath, { recursive: true, force: true });
    await rm(exeDir, { recursive: true, force: true });
  }
});

test("packaged app falls back to ~/.minke when the exe directory is unusable", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "minke-home-"));
  const exeDir = await mkdtemp(join(tmpdir(), "minke-exe-"));
  // A file named "data" blocks portable storage, simulating an unusable path.
  await writeFile(join(exeDir, "data"), "not-a-directory");
  const calls = [];
  const previousDshHome = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    configureAppDataPaths(
      {
        isPackaged: true,
        getAppPath: () => {
          throw new Error("packaged layout must not use the app path");
        },
        getPath: () => homePath,
        setPath(name, path) {
          calls.push([name, path]);
        },
      },
      { execPath: join(exeDir, "Minke.exe") },
    );

    assert.deepEqual(calls, [
      ["userData", join(homePath, ".minke")],
      ["sessionData", join(homePath, ".minke")],
    ]);
    assert.equal(process.env.DSH_HOME, undefined);
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    await rm(homePath, { recursive: true, force: true });
    await rm(exeDir, { recursive: true, force: true });
  }
});

test("an explicit DSH_HOME is never overridden", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "minke-project-"));
  const forcedDshHome = join(projectRoot, "custom-dsh");
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = forcedDshHome;
  try {
    configureAppDataPaths(
      devApp(projectRoot, () => {}, () => projectRoot),
    );
    assert.equal(process.env.DSH_HOME, forcedDshHome);
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
