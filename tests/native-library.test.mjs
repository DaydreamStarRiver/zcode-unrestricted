import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { original, temporary, publicSourceFixture, PLUGIN_ID } from "./native-fixture.mjs";
import { nativeLibrary } from "./library-fixture.mjs";
import { install, locations } from "../tools/install-lib.mjs";
import { atomicWrite, jsonBytes } from "../tools/files.mjs";

async function fixture(t) {
  const directory = await temporary(t);
  const appDirectory = path.join(directory, "app");
  const userHome = path.join(directory, "user");
  const workspace = path.join(directory, "workspace");
  const paths = locations(appDirectory, userHome);
  await fs.mkdir(paths.glm, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(paths.agent, original);
  await install({ appDirectory, userHome, sourceRoot: await publicSourceFixture(directory), checkRunning: false });
  const bridgeFile = path.join(paths.bridgeRoot, "bridge.cjs");
  const bridge = createRequire(bridgeFile)(bridgeFile);
  const library = nativeLibrary(userHome, workspace, bridge);
  const runtime = { config: { presentationSurface: "zcode_desktop", taskType: "interactive" }, workspaceRoot: workspace, workingDirectory: workspace, sessionId: "native-library-offline" };
  const base = { workingDirectory: workspace, presentationSurface: "zcode_desktop", currentDate: "2026-10-11", envInfo: { workingDirectory: workspace, platform: "win32", osVersion: "offline", shell: "powershell" } };
  const parse = () => library.createConfig({ workingDirectory: workspace });
  const turn = () => bridge.beginTurn(runtime, {}, undefined, parse);
  const build = () => library.createBuilder(bridge.contextConfig(runtime, base)).build();
  return { directory, paths, workspace, bridge, library, runtime, base, parse, turn, build };
}

test("actual packaged native plugin adapter recognizes installed inline plugin and prompt file option", async (t) => {
  const f = await fixture(t);
  const loaded = await f.library.createPluginAdapter({ storageRoot: path.join(f.paths.userBase, "plugins") }).discoverPlugins({
    config: f.parse().config.plugins,
    storageRoot: path.join(f.paths.userBase, "plugins"), workingDirectory: f.workspace,
    officialPluginRoots: [], env: {},
  });
  const plugin = loaded.plugins.find((entry) => entry.id === PLUGIN_ID);
  assert.ok(plugin, "Plugin must be discoverable by native installed adapter");
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.name, "zcode-unrestricted");
  assert.equal(plugin.userConfig.promptFile.type, "file");
  assert.equal(plugin.rootPath, f.paths.pluginRoot);
  assert.equal(plugin.dataPath, f.paths.dataRoot);
});

test("actual packaged native parser and full builder perform hot replacement and restore identical default system", async (t) => {
  const f = await fixture(t);
  await f.turn();
  const baseline = f.build();
  assert.ok(baseline.systemMessages.some((message) => message.content.includes("You are ZCode")));
  const config = JSON.parse(await fs.readFile(f.paths.config, "utf8"));
  config.plugins.enabledPlugins[PLUGIN_ID] = true;
  await atomicWrite(f.paths.config, jsonBytes(config));
  await f.turn();
  const active = f.build();
  const prompt = await fs.readFile(f.paths.prompt, "utf8");
  assert.equal(active.systemMessages.length, 1);
  assert.equal(active.systemMessages[0].content.trim(), prompt.trim());
  assert.deepEqual(JSON.parse(JSON.stringify(active.metaUserAttachments)), JSON.parse(JSON.stringify(baseline.metaUserAttachments)));
  config.plugins.enabledPlugins[PLUGIN_ID] = false;
  await atomicWrite(f.paths.config, jsonBytes(config));
  assert.equal(f.build().systemMessages[0].content.trim(), prompt.trim(), "Current snapshot must not change midway");
  await f.turn();
  assert.deepEqual(JSON.parse(JSON.stringify(f.build().systemMessages)), JSON.parse(JSON.stringify(baseline.systemMessages)));
});

test("actual native schema/parent-project precedence drives hot enable and file selection", async (t) => {
  const f = await fixture(t);
  const user = JSON.parse(await fs.readFile(f.paths.config, "utf8"));
  user.plugins.enabledPlugins[PLUGIN_ID] = true;
  await atomicWrite(f.paths.config, jsonBytes(user));
  const projectConfig = path.join(f.workspace, ".zcode", "config.json");
  const project = { plugins: { enabledPlugins: { [PLUGIN_ID]: false }, options: { [PLUGIN_ID]: { promptFile: "selected.md" } } } };
  await atomicWrite(projectConfig, jsonBytes(project));
  assert.equal(f.parse().config.plugins.enabledPlugins[PLUGIN_ID], false);
  await f.turn();
  assert.ok(f.build().systemMessages.some((message) => message.content.includes("You are ZCode")));
  await fs.writeFile(path.join(f.workspace, "selected.md"), "NATIVE PROJECT PROMPT");
  project.plugins.enabledPlugins[PLUGIN_ID] = true;
  await atomicWrite(projectConfig, jsonBytes(project));
  assert.equal(f.parse().config.plugins.enabledPlugins[PLUGIN_ID], true);
  assert.equal(f.parse().config.plugins.options[PLUGIN_ID].promptFile, "selected.md");
  await f.turn();
  assert.equal(f.build().systemMessages.length, 1);
  assert.equal(f.build().systemMessages[0].content.trim(), "NATIVE PROJECT PROMPT");
});
