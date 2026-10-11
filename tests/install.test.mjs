import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { root, original, temporary, publicSourceFixture, PLUGIN_ID, readOriginalAgent } from "./native-fixture.mjs";
import { install, uninstall, status, locations, legacyLocations, LEGACY_PLUGIN_ID, LEGACY_PATCH_SHA256, LEGACY_MARKER } from "../tools/install-lib.mjs";
import { patchBundle, PATCHES, MARKER, ORIGINAL_SHA256, sha256 } from "../tools/patch.mjs";
import { atomicWrite, compareAndWrite, jsonBytes } from "../tools/files.mjs";

async function installation(t) {
  const directory = await temporary(t);
  const appDirectory = path.join(directory, "ZCode");
  const userHome = path.join(directory, "user");
  const paths = locations(appDirectory, userHome);
  await fs.mkdir(paths.glm, { recursive: true });
  await fs.writeFile(paths.agent, original);
  await atomicWrite(paths.config, jsonBytes({ providers: { test: { key: "KEEP_EXISTING_TEST_VALUE" } }, plugins: { dirs: [path.join(directory, "other")], enabledPlugins: { "other@inline": true } } }));
  return { appDirectory, userHome, sourceRoot: await publicSourceFixture(directory), checkRunning: false, paths };
}

async function legacyInstallation(t) {
  const fixture = await installation(t);
  const old = legacyLocations(fixture.appDirectory, fixture.userHome);
  const legacyCode = patchBundle(original).bytes.toString("utf8")
    .replaceAll(MARKER, LEGACY_MARKER)
    .replaceAll("__zcodeUnrestrictedBridge", "__dshBridge")
    .replaceAll("./zcode-unrestricted-native/bridge.cjs", "./dsh-native/bridge.cjs");
  const legacyAgent = Buffer.from(legacyCode, "utf8");
  assert.equal(sha256(legacyAgent), LEGACY_PATCH_SHA256);
  const bridge = Buffer.from("// legacy bridge fixture\n");
  const binding = jsonBytes({ version: 1, pluginId: LEGACY_PLUGIN_ID, pluginRoot: old.pluginRoot, promptFile: old.prompt, statusFile: old.status });
  await atomicWrite(old.agent, legacyAgent);
  await atomicWrite(old.backup, original);
  await atomicWrite(old.prompt, Buffer.from("LEGACY USER EDITED 中文\n"));
  await atomicWrite(path.join(old.bridgeRoot, "bridge.cjs"), bridge);
  await atomicWrite(path.join(old.bridgeRoot, "binding.json"), binding);
  await atomicWrite(old.receipt, jsonBytes({
    version: 1, pluginVersion: "0.2.0", agent: old.agent, pluginRoot: old.pluginRoot, userHome: fixture.userHome,
    originalHash: ORIGINAL_SHA256, patchedHash: LEGACY_PATCH_SHA256, bridgeHash: sha256(bridge), bindingHash: sha256(binding),
  }));
  const config = JSON.parse(await fs.readFile(old.config, "utf8"));
  config.plugins.dirs.push(old.pluginRoot);
  config.plugins.enabledPlugins[LEGACY_PLUGIN_ID] = true;
  config.plugins.options = { [LEGACY_PLUGIN_ID]: { promptFile: path.join(path.dirname(fixture.appDirectory), "custom-prompt.md") } };
  await atomicWrite(old.config, jsonBytes(config));
  return { ...fixture, old, legacyAgent, bridge, binding };
}

test("rename migrates verified legacy installation, user options and edited prompt; uninstall still restores original", async (t) => {
  const f = await legacyInstallation(t);
  const oldPrompt = await fs.readFile(f.old.prompt);
  const before = JSON.parse(await fs.readFile(f.old.config, "utf8"));
  assert.equal((await status(f)).state, "legacy_mounted");
  assert.deepEqual(await readOriginalAgent(f.old.agent, f.userHome), original);
  const result = await install(f);
  assert.equal(result.migratedLegacy, true);
  const config = JSON.parse(await fs.readFile(f.paths.config, "utf8"));
  assert.equal(config.plugins.enabledPlugins[PLUGIN_ID], true);
  assert.ok(!(LEGACY_PLUGIN_ID in config.plugins.enabledPlugins));
  assert.ok(!(LEGACY_PLUGIN_ID in config.plugins.options));
  assert.deepEqual(config.plugins.options[PLUGIN_ID], before.plugins.options[LEGACY_PLUGIN_ID]);
  assert.ok(!config.plugins.dirs.includes(f.old.pluginRoot));
  assert.ok(config.plugins.dirs.includes(f.paths.pluginRoot));
  assert.deepEqual(config.providers, before.providers);
  assert.deepEqual(await fs.readFile(f.paths.prompt), oldPrompt);
  assert.deepEqual(await fs.readFile(f.old.prompt), oldPrompt);
  assert.deepEqual(await fs.readFile(f.old.backup), original);
  await assert.rejects(fs.access(path.join(f.old.bridgeRoot, "bridge.cjs")), { code: "ENOENT" });
  assert.equal((await status(f)).state, "mounted");
  await uninstall(f);
  assert.deepEqual(await fs.readFile(f.paths.agent), original);
  assert.deepEqual(await fs.readFile(f.paths.prompt), oldPrompt);
});

test("new uninstaller can restore a verified legacy installation without migrating it", async (t) => {
  const f = await legacyInstallation(t);
  const prompt = await fs.readFile(f.old.prompt);
  await uninstall(f);
  assert.deepEqual(await fs.readFile(f.paths.agent), original);
  assert.deepEqual(await fs.readFile(f.old.prompt), prompt);
  const config = JSON.parse(await fs.readFile(f.paths.config, "utf8"));
  assert.ok(!(LEGACY_PLUGIN_ID in config.plugins.enabledPlugins));
  assert.equal(config.plugins.enabledPlugins["other@inline"], true);
});

test("failed legacy cleanup rolls back both generations of bridge, Agent, config and new receipt", async (t) => {
  const f = await legacyInstallation(t);
  const before = await fs.readFile(f.paths.config);
  const unlink = fs.unlink;
  let failed = false;
  fs.unlink = async (file) => {
    if (file === path.join(f.old.bridgeRoot, "binding.json") && !failed) {
      failed = true;
      throw new Error("Injected legacy cleanup failure");
    }
    return unlink(file);
  };
  try { await assert.rejects(install(f), /Injected legacy cleanup failure/); }
  finally { fs.unlink = unlink; }
  assert.equal(failed, true);
  assert.deepEqual(await fs.readFile(f.paths.agent), f.legacyAgent);
  assert.deepEqual(await fs.readFile(f.paths.config), before);
  assert.deepEqual(await fs.readFile(path.join(f.old.bridgeRoot, "bridge.cjs")), f.bridge);
  assert.deepEqual(await fs.readFile(path.join(f.old.bridgeRoot, "binding.json")), f.binding);
  await assert.rejects(fs.access(f.paths.receipt), { code: "ENOENT" });
  assert.equal((await status(f)).state, "legacy_mounted");
});

test("legacy bridge modifications are rejected and an existing new prompt is never overwritten", async (t) => {
  const f = await legacyInstallation(t);
  const before = await fs.readFile(f.paths.config);
  await fs.writeFile(path.join(f.old.bridgeRoot, "bridge.cjs"), "USER CHANGED BRIDGE");
  await assert.rejects(install(f), /Legacy bridge\/binding checksum/);
  assert.deepEqual(await fs.readFile(f.paths.config), before);
  assert.deepEqual(await fs.readFile(f.paths.agent), f.legacyAgent);
  await fs.writeFile(path.join(f.old.bridgeRoot, "bridge.cjs"), f.bridge);
  await atomicWrite(f.paths.prompt, Buffer.from("NEW USER PROMPT"));
  await install(f);
  assert.equal(await fs.readFile(f.paths.prompt, "utf8"), "NEW USER PROMPT");
});

test("legacy lock blocks the new installer without changing config or Agent", async (t) => {
  const f = await installation(t);
  const old = legacyLocations(f.appDirectory, f.userHome);
  const before = await fs.readFile(f.paths.config);
  await fs.writeFile(old.lock, "123");
  await assert.rejects(install(f), /Another install/);
  assert.deepEqual(await fs.readFile(f.paths.config), before);
  assert.deepEqual(await fs.readFile(f.paths.agent), original);
});

test("patch is allowlisted, each anchor is unique, only planned edits occur", () => {
  assert.equal(sha256(original), ORIGINAL_SHA256);
  const patched = patchBundle(original);
  const code = patched.bytes.toString("utf8");
  assert.equal(code.split(MARKER).length, 2);
  let reconstructed = code;
  for (const item of [...PATCHES].reverse()) {
    assert.equal(reconstructed.split(item.after).length, 2);
    reconstructed = reconstructed.replace(item.after, item.before);
  }
  assert.deepEqual(Buffer.from(reconstructed, "utf8"), original);
  assert.throws(() => patchBundle(Buffer.concat([original, Buffer.from("\n// changed")])) , /Unsupported Agent/);
});

test("install/reinstall preserve unrelated configuration, edited prompt and native switch", async (t) => {
  const fixture = await installation(t);
  const result = await install(fixture);
  assert.equal(result.state, "installed");
  assert.deepEqual(await fs.readFile(fixture.paths.backup), original);
  assert.deepEqual(await readOriginalAgent(fixture.paths.agent, fixture.userHome), original);
  let config = JSON.parse(await fs.readFile(fixture.paths.config, "utf8"));
  assert.equal(config.providers.test.key, "KEEP_EXISTING_TEST_VALUE");
  assert.equal(config.plugins.enabledPlugins[PLUGIN_ID], false);
  assert.equal(config.plugins.enabledPlugins["other@inline"], true);
  assert.equal(config.plugins.dirs.filter((value) => value === fixture.paths.pluginRoot).length, 1);
  assert.deepEqual(await fs.readFile(fixture.paths.prompt), await fs.readFile(path.join(fixture.sourceRoot, "plugins/zcode-unrestricted/prompts/example-system.md")));
  await fs.writeFile(fixture.paths.prompt, "USER EDITED");
  config.plugins.enabledPlugins[PLUGIN_ID] = true;
  await atomicWrite(fixture.paths.config, jsonBytes(config));
  const hashBefore = sha256(await fs.readFile(fixture.paths.agent));
  await install(fixture);
  assert.equal(sha256(await fs.readFile(fixture.paths.agent)), hashBefore);
  assert.equal(await fs.readFile(fixture.paths.prompt, "utf8"), "USER EDITED");
  config = JSON.parse(await fs.readFile(fixture.paths.config, "utf8"));
  assert.equal(config.plugins.enabledPlugins[PLUGIN_ID], true);
  assert.equal(config.plugins.dirs.filter((value) => value === fixture.paths.pluginRoot).length, 1);
  const state = await status(fixture);
  assert.equal(state.state, "mounted");
  assert.equal(state.userEnabled, true);
  assert.doesNotMatch(JSON.stringify(state), /KEEP_EXISTING_TEST_VALUE|USER EDITED/);
});

test("uninstall restores exact original bytes and removes only this plugin registration", async (t) => {
  const fixture = await installation(t);
  await install(fixture);
  const prompt = await fs.readFile(fixture.paths.prompt);
  const result = await uninstall(fixture);
  assert.equal(result.restored, true);
  assert.deepEqual(await fs.readFile(fixture.paths.agent), original);
  assert.deepEqual(await fs.readFile(fixture.paths.prompt), prompt);
  const config = JSON.parse(await fs.readFile(fixture.paths.config, "utf8"));
  assert.equal(config.providers.test.key, "KEEP_EXISTING_TEST_VALUE");
  assert.equal(config.plugins.enabledPlugins["other@inline"], true);
  assert.ok(!(PLUGIN_ID in config.plugins.enabledPlugins));
  assert.ok(!config.plugins.dirs.includes(fixture.paths.pluginRoot));
  assert.equal((await status(fixture)).state, "unmounted");
  await uninstall(fixture);
  assert.deepEqual(await fs.readFile(fixture.paths.agent), original);
});

test("upgrade is preserved during uninstall; old original is never restored into a newer Agent", async (t) => {
  const fixture = await installation(t);
  await install(fixture);
  const upgraded = Buffer.concat([original, Buffer.from("\n// Simulated upstream update\n")]);
  await fs.writeFile(fixture.paths.agent, upgraded);
  // 模拟更新器清掉桥接目录；持久 receipt/backup 仍必须能用于安全卸载。
  await fs.unlink(path.join(fixture.paths.bridgeRoot, "bridge.cjs"));
  await fs.unlink(path.join(fixture.paths.bridgeRoot, "binding.json"));
  const result = await uninstall(fixture);
  assert.equal(result.restored, false);
  assert.equal(result.upgradedAgentKept, true);
  assert.deepEqual(await fs.readFile(fixture.paths.agent), upgraded);
});

test("unknown original/modified patch/corrupt backup refuse mutation", async (t) => {
  const fixture = await installation(t);
  const configBefore = await fs.readFile(fixture.paths.config);
  const changed = Buffer.concat([original, Buffer.from("\n// changed")]);
  await fs.writeFile(fixture.paths.agent, changed);
  await assert.rejects(install(fixture), /Unsupported Agent/);
  assert.deepEqual(await fs.readFile(fixture.paths.config), configBefore);
  await fs.writeFile(fixture.paths.agent, original);
  await install(fixture);
  const patchWithOtherChanges = Buffer.concat([await fs.readFile(fixture.paths.agent), Buffer.from("\n// another modification")]);
  await fs.writeFile(fixture.paths.agent, patchWithOtherChanges);
  const registeredConfig = await fs.readFile(fixture.paths.config);
  await assert.rejects(uninstall(fixture), /other changes/);
  assert.deepEqual(await fs.readFile(fixture.paths.agent), patchWithOtherChanges);
  assert.deepEqual(await fs.readFile(fixture.paths.config), registeredConfig);
  await fs.writeFile(fixture.paths.backup, "CORRUPTED");
  await assert.rejects(uninstall(fixture), /backup checksum/);
});

test("failed package preparation leaves original Agent and config untouched", async (t) => {
  const fixture = await installation(t);
  const sourceRoot = path.join(path.dirname(fixture.appDirectory), "broken-package");
  await atomicWrite(path.join(sourceRoot, "plugins/zcode-unrestricted/.zcode-plugin/plugin.json"), jsonBytes({ name: "zcode-unrestricted" }));
  await atomicWrite(path.join(sourceRoot, "plugins/zcode-unrestricted/native/bridge.cjs"), await fs.readFile(path.join(root, "plugins/zcode-unrestricted/native/bridge.cjs")));
  const before = await fs.readFile(fixture.paths.config);
  await assert.rejects(install({ ...fixture, sourceRoot }), /ENOENT/);
  assert.deepEqual(await fs.readFile(fixture.paths.agent), original);
  assert.deepEqual(await fs.readFile(fixture.paths.config), before);
  // 中断记录可恢复，补齐交付后重试仍能成功。
  await install(fixture);
  assert.equal((await status(fixture)).state, "mounted");
});

test("mount status requires the bridge and binding checksums, not only patched Agent", async (t) => {
  const fixture = await installation(t);
  await install(fixture);
  const bridgeFile = path.join(fixture.paths.bridgeRoot, "bridge.cjs");
  await fs.unlink(bridgeFile);
  assert.equal((await status(fixture)).state, "unmounted");
  await install(fixture);
  assert.equal((await status(fixture)).state, "mounted");
  await fs.writeFile(path.join(fixture.paths.bridgeRoot, "binding.json"), "{}");
  assert.equal((await status(fixture)).state, "unmounted");
});

test("config concurrent changes are detected without overwriting the new file", async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, "config.json");
  const first = jsonBytes({ plugins: {}, other: "FIRST" });
  const second = jsonBytes({ plugins: {}, other: "SECOND" });
  await atomicWrite(file, first);
  await atomicWrite(file, second);
  await assert.rejects(compareAndWrite(file, first, jsonBytes({ other: "THIRD" })), /concurrently/);
  assert.deepEqual(await fs.readFile(file), second);
});

test("failed final Agent replacement rolls back already-written config, bridge and receipt", async (t) => {
  const fixture = await installation(t);
  const configBefore = await fs.readFile(fixture.paths.config);
  const rename = fs.rename;
  let failed = false;
  fs.rename = async (from, to) => {
    if (to === fixture.paths.agent && !failed) {
      failed = true;
      throw Object.assign(new Error("Injected final write failure"), { code: "EPERM" });
    }
    return rename(from, to);
  };
  try { await assert.rejects(install(fixture), /Injected final write failure/); }
  finally { fs.rename = rename; }
  assert.equal(failed, true);
  assert.deepEqual(await fs.readFile(fixture.paths.agent), original);
  assert.deepEqual(await fs.readFile(fixture.paths.config), configBefore);
  await assert.rejects(fs.access(fixture.paths.receipt), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(fixture.paths.bridgeRoot, "bridge.cjs")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(fixture.paths.prompt), await fs.readFile(path.join(fixture.sourceRoot, "plugins/zcode-unrestricted/prompts/example-system.md")));
  await install(fixture);
  assert.equal((await status(fixture)).state, "mounted");
});
