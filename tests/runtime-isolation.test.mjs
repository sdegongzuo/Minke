import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { harnessRuntimeEnvironment } from "@minke/desktop/main/harness-runtime.ts";
import { harnessWebArguments } from "@minke/desktop/main/harness-launch.ts";
import { configureAppDataPaths } from "@minke/desktop/main/app-data-paths.ts";
import { DataHomeManager, buildDshChildEnvironment } from "@minke/desktop/main/data-home.ts";
import { WebPluginProfile } from "@minke/desktop/main/plugin-installation/profile.ts";

// Keep fixtures for inspection; this workspace forbids automatic file deletion.
const root = await mkdtemp(join(tmpdir(), "minke-isolation-"));
const external = join(root, "external-dsh");
await mkdir(join(external, "profiles", "web"), { recursive: true });
await writeFile(join(external, "profiles", "web", "package.json"), JSON.stringify({
  dependencies: { "fictional-external-plugin": "1.0.0" },
  dsh: { profile: { bundles: ["fictional-external-plugin"] } },
}));

test("packaged startup does not inherit another Harness or its plugins", async () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = external;
  const paths = {};
  const exeDir = join(root, "app-a");
  try {
    configureAppDataPaths({
      isPackaged: true,
      getAppPath: () => exeDir,
      getPath: () => root,
      setPath: (name, value) => { paths[name] = value; },
    }, { execPath: join(exeDir, "Minke.exe") });
    const manager = new DataHomeManager({
      userDataPath: paths.userData,
      homeDirectory: root,
      configuration: { read: async () => undefined },
    });
    const dshHome = await manager.activePath();
    const profile = new WebPluginProfile({ runtimeRoot: root, dshHome, electronExecutable: process.execPath });
    assert.deepEqual((await profile.list({ safeMode: false, disabledPlugins: [] })).plugins, []);
    assert.equal(dshHome, join(exeDir, "data", "dsh"));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("unusable portable storage fails instead of sharing the OS home", async () => {
  const exeDir = join(root, "blocked-app");
  await mkdir(exeDir);
  await writeFile(join(exeDir, "data"), "occupied");
  assert.throws(() => configureAppDataPaths({
    isPackaged: true,
    getAppPath: () => exeDir,
    getPath: () => root,
    setPath: () => {},
  }, { execPath: join(exeDir, "Minke.exe") }), /portable|data directory/i);
});

test("child skill roots and package caches belong to the selected Harness", () => {
  const active = join(root, "app-b", "data", "dsh");
  const inherited = {
    DSH_HOME: external,
    dsh_agents_home: join(root, "shared-agents"),
    DSH_BUNDLED_SKILL_DIR: join(root, "external-bundled"),
    npm_config_cache: join(root, "external-cache"),
    NPM_CONFIG_STORE_DIR: join(root, "external-store"),
    PATH: "toolchain",
  };
  const child = buildDshChildEnvironment(active, inherited);
  assert.equal(child.DSH_HOME, active);
  assert.equal(child.DSH_AGENTS_HOME, join(active, "agents"));
  assert.equal(child.dsh_agents_home, undefined);
  assert.equal(child.DSH_BUNDLED_SKILL_DIR, undefined);
  assert.equal(child.npm_config_cache, join(active, "cache", "npm"));
  assert.equal(child.npm_config_store_dir, join(active, "cache", "pnpm"));
  assert.equal(child.NPM_CONFIG_STORE_DIR, undefined);
  assert.equal(inherited.DSH_HOME, external);
  assert.equal(child.PATH, "toolchain");
  assert.equal(child.USERPROFILE, join(active, "home"));
  assert.equal(child.HOME, join(active, "home"));
  assert.equal(child.APPDATA, join(active, "home", "config"));
  assert.equal(child.LOCALAPPDATA, join(active, "home", "local"));
});

test("parallel runtime children have separate homes, stores, and dynamic ports", async () => {
  const layout = { entryPath: join(root, "index.mjs"), productPatch: "product.yml", pnpmEntry: "pnpm.cjs", runtimeBin: join(root, "bin") };
  assert.deepEqual(harnessWebArguments(layout).slice(-4), ["--host", "127.0.0.1", "--port", "0"]);
  const reports = await Promise.all(["one", "two"].map(async name => {
    const dshHome = join(root, name, "data", "dsh");
    await mkdir(join(dshHome, "home"), { recursive: true });
    const env = harnessRuntimeEnvironment(layout, {
      dshHome,
      electronExecutable: process.execPath,
      modelRuntimes: { lmStudio: { enabled: false }, ollama: { enabled: false } },
    }, { ...process.env, DSH_HOME: external });
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", `
      const { homedir } = require('node:os');
      const server = require('node:net').createServer();
      server.listen(0, '127.0.0.1', () => {
        console.log(JSON.stringify({ home: homedir(), dsh: process.env.DSH_HOME, port: server.address().port }));
        setTimeout(() => server.close(), 1000);
      });
    `], { env, cwd: dshHome });
    const report = JSON.parse(stdout);
    assert.equal(report.home, join(dshHome, "home"));
    assert.equal(report.dsh, dshHome);
    return report;
  }));
  assert.notEqual(reports[0].port, reports[1].port);
  assert.notEqual(reports[0].home, reports[1].home);
});

test("plugin installation uses the private profile and environment", async () => {
  const dshHome = join(root, "install", "data", "dsh");
  let command;
  const profile = new WebPluginProfile({
    runtimeRoot: root, dshHome, electronExecutable: process.execPath,
    environment: { DSH_HOME: external, HOME: root, USERPROFILE: root },
    readRuntimeLayout: async () => ({ entryPath: join(root, "bundled-index.mjs"), pnpmEntry: "pnpm.cjs", runtimeBin: join(root, "bin") }),
    runCommand: async (executable, args, options) => { command = { executable, args, options }; },
  });
  await profile.add("fictional-private-plugin");
  assert.equal(command.options.cwd, dshHome);
  assert.equal(command.options.env.DSH_HOME, dshHome);
  assert.equal(command.options.env.USERPROFILE, join(dshHome, "home"));
  assert.equal(command.options.env.npm_config_store_dir, join(dshHome, "cache", "pnpm"));
  assert.deepEqual(command.args.slice(1), [join(root, "bundled-index.mjs"), "plugin", "--profile", "web", "add", "fictional-private-plugin"]);
});

test("new data manager does not default to the separately installed Harness", async () => {
  const userDataPath = join(root, "manager", "minke");
  const manager = new DataHomeManager({
    userDataPath,
    homeDirectory: root,
    environment: {},
    configuration: { read: async () => undefined },
  });
  assert.equal(await manager.activePath(), join(userDataPath, "harness"));
  assert.equal((await manager.read()).candidates.some(item => item.path === join(root, ".dsh")), false);
});
