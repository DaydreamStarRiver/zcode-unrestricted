import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import vm from "node:vm";
import { VERSION, MARKER, ORIGINAL_SHA256, SUPPORTED_DESKTOP, sha256, patchBundle } from "./patch.mjs";
import { atomicWrite, optionalBytes, jsonObject, jsonBytes, compareAndWrite, compareAndRemove, restoreOwned } from "./files.mjs";

export const PLUGIN_ID = "zcode-unrestricted@inline";
export const LEGACY_PLUGIN_ID = "dsh-unrestricted@inline";
export const LEGACY_PATCH_SHA256 = "f7ce651cc08dfe463ca9dcdb0b7d098eabef4c856ef2f2deffbdd01565c25600";
export const LEGACY_MARKER = "/* DSH_DESKTOP_BRIDGE_v1 */";
const execute = promisify(execFile);
const equalPath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function locations(appDirectory, userHome) {
  return installationLocations(appDirectory, userHome, "zcode-unrestricted", "zcode-unrestricted-native");
}

export function legacyLocations(appDirectory, userHome) {
  return installationLocations(appDirectory, userHome, "dsh-unrestricted", "dsh-native");
}

function installationLocations(appDirectory, userHome, name, bridgeName) {
  if (!path.isAbsolute(appDirectory) || !path.isAbsolute(userHome)) throw new Error("Absolute installation and user paths required");
  const glm = path.join(appDirectory, "resources", "glm");
  const userBase = path.join(userHome, ".zcode", "cli");
  const pluginId = `${name}@inline`;
  const pluginRoot = path.join(userBase, "plugins", "local", name);
  const dataRoot = path.join(userBase, "plugins", "data", pluginId);
  // 更新器可能替换整个 resources/glm；备份和 receipt 必须留在用户持久目录。
  const installKey = sha256(Buffer.from(path.resolve(appDirectory).toLowerCase(), "utf8"));
  const stateRoot = path.join(userBase, "desktop-patches", name, installKey);
  return {
    appDirectory, glm, userBase, pluginId, pluginRoot, dataRoot, stateRoot,
    agent: path.join(glm, "zcode.cjs"), bridgeRoot: path.join(glm, bridgeName),
    config: path.join(userBase, "config.json"), prompt: path.join(dataRoot, "system.md"),
    status: path.join(dataRoot, "last-turn.json"), receipt: path.join(stateRoot, "receipt.json"),
    backup: path.join(stateRoot, "original.cjs"), lock: path.join(glm, `.${name}.lock`),
  };
}

export async function assertAppClosed(appDirectory) {
  if (process.platform !== "win32") throw new Error("This installer supports Windows Desktop only");
  // 只读进程路径，不输出 CommandLine（可能含用户数据）；不会结束进程。
  const command = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);[void][System.Reflection.Assembly]::LoadWithPartialName('System.Management');$searcher=[System.Management.ManagementObjectSearcher]::new(\"SELECT ExecutablePath FROM Win32_Process WHERE Name='ZCode.exe'\");try{foreach($entry in $searcher.Get()){if($entry.ExecutablePath){[Console]::WriteLine($entry.ExecutablePath)}else{[Console]::WriteLine('UNKNOWN_ZCODE_PROCESS')}}}finally{$searcher.Dispose()}";
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 15000 });
  const target = path.join(appDirectory, "ZCode.exe");
  if (stdout.split(/\r?\n/).some((line) => line.trim() === "UNKNOWN_ZCODE_PROCESS" || (line.trim() && equalPath(line.trim(), target)))) {
    throw new Error("Close ZCode completely (including tray/background processes), then retry. No process was stopped.");
  }
}

async function withLock(paths, task) {
  const locks = [];
  const oldLock = legacyLocations(paths.appDirectory, path.dirname(path.dirname(paths.userBase))).lock;
  try {
    // 兼容旧安装器的锁，防止两个版本同时修改同一个 Agent。
    for (const file of [...new Set([paths.lock, oldLock])].sort()) {
      const handle = await fs.open(file, "wx").catch((error) => {
        if (error.code === "EEXIST") throw new Error("Another install is active, or a previous install was interrupted. Check status before removing the .lock file.");
        throw error;
      });
      locks.push({ file, handle });
      await handle.writeFile(String(process.pid));
    }
    return await task();
  } finally {
    for (const { file, handle } of locks.reverse()) { await handle.close(); await fs.unlink(file); }
  }
}

function updateRegistration(config, paths, add) {
  const next = structuredClone(config);
  const plugins = next.plugins ??= {};
  if (typeof plugins !== "object" || Array.isArray(plugins)) throw new Error("Invalid plugins config");
  const dirs = plugins.dirs ?? [];
  if (!Array.isArray(dirs) || dirs.some((value) => typeof value !== "string")) throw new Error("Invalid plugins.dirs config");
  const matches = (value) => equalPath(value, paths.pluginRoot);
  plugins.dirs = add ? (dirs.some(matches) ? dirs : [...dirs, paths.pluginRoot]) : dirs.filter((value) => !matches(value));
  plugins.enabledPlugins ??= {};
  if (typeof plugins.enabledPlugins !== "object" || Array.isArray(plugins.enabledPlugins)) throw new Error("Invalid plugins.enabledPlugins config");
  if (add) {
    if (plugins.enabledPlugins[paths.pluginId] === undefined) plugins.enabledPlugins[paths.pluginId] = false;
  } else {
    delete plugins.enabledPlugins[paths.pluginId];
    if (plugins.options && typeof plugins.options === "object") delete plugins.options[paths.pluginId];
  }
  return next;
}

function bindingBytes(paths) {
  return jsonBytes({ version: 1, pluginId: PLUGIN_ID, pluginRoot: paths.pluginRoot, promptFile: paths.prompt, statusFile: paths.status });
}

function migrateRegistration(config, paths, oldPaths) {
  const next = structuredClone(config);
  const plugins = next.plugins ??= {};
  if (plugins.enabledPlugins?.[PLUGIN_ID] === undefined && plugins.enabledPlugins?.[LEGACY_PLUGIN_ID] !== undefined) {
    plugins.enabledPlugins[PLUGIN_ID] = plugins.enabledPlugins[LEGACY_PLUGIN_ID];
  }
  if (plugins.options?.[LEGACY_PLUGIN_ID] !== undefined) {
    const oldOptions = plugins.options[LEGACY_PLUGIN_ID];
    const newOptions = plugins.options[PLUGIN_ID] ?? {};
    if (!oldOptions || typeof oldOptions !== "object" || Array.isArray(oldOptions) ||
        !newOptions || typeof newOptions !== "object" || Array.isArray(newOptions)) throw new Error("Invalid plugin options");
    plugins.options[PLUGIN_ID] = { ...oldOptions, ...newOptions };
  }
  return updateRegistration(updateRegistration(next, oldPaths, false), paths, true);
}

async function copyPlugin(sourceRoot, paths, bridge, legacyPrompt = null) {
  const pluginSource = path.join(sourceRoot, "plugins", "zcode-unrestricted");
  const sourceManifest = await fs.readFile(path.join(pluginSource, ".zcode-plugin", "plugin.json"));
  if (jsonObject(sourceManifest).name !== "zcode-unrestricted") throw new Error("Invalid plugin package");
  const installedManifest = await optionalBytes(path.join(paths.pluginRoot, ".zcode-plugin", "plugin.json"));
  if (installedManifest && jsonObject(installedManifest).name !== "zcode-unrestricted") throw new Error("Plugin target belongs to a different package");
  await atomicWrite(path.join(paths.pluginRoot, ".zcode-plugin", "plugin.json"), sourceManifest);
  await atomicWrite(path.join(paths.pluginRoot, "README.md"), await fs.readFile(path.join(pluginSource, "README.md")));
  await atomicWrite(path.join(paths.pluginRoot, "native", "bridge.cjs"), bridge);
  await fs.mkdir(paths.dataRoot, { recursive: true });
  if (await optionalBytes(paths.prompt) === null) {
    const custom = legacyPrompt ?? await optionalBytes(path.join(pluginSource, "prompts", "system.md"));
    const prompt = custom ?? await fs.readFile(path.join(pluginSource, "prompts", "example-system.md"));
    try { await fs.writeFile(paths.prompt, prompt, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  await atomicWrite(path.join(paths.bridgeRoot, "bridge.cjs"), bridge);
  await atomicWrite(path.join(paths.bridgeRoot, "binding.json"), bindingBytes(paths));
}

function checkedReceipt(receipt, paths) {
  if (receipt.version !== 1 || receipt.originalHash !== ORIGINAL_SHA256 ||
      !/^[a-f0-9]{64}$/.test(receipt.patchedHash ?? "") || !/^[a-f0-9]{64}$/.test(receipt.bridgeHash ?? "") ||
      !/^[a-f0-9]{64}$/.test(receipt.bindingHash ?? "") || typeof receipt.agent !== "string" ||
      typeof receipt.pluginRoot !== "string" || typeof receipt.userHome !== "string" || !equalPath(receipt.agent, paths.agent) ||
      !equalPath(receipt.pluginRoot, paths.pluginRoot) || !equalPath(receipt.userHome, path.dirname(path.dirname(paths.userBase)))) {
    throw new Error("Receipt does not match this installation/user. Refusing to restore.");
  }
  return receipt;
}

async function installationRecord(appDirectory, userHome, current) {
  const paths = locations(appDirectory, userHome);
  const oldPaths = legacyLocations(appDirectory, userHome);
  const newBytes = await optionalBytes(paths.receipt);
  const oldBytes = await optionalBytes(oldPaths.receipt);
  const currentHash = current ? sha256(current) : null;
  if (oldBytes && (currentHash === LEGACY_PATCH_SHA256 || !newBytes)) {
    const receipt = checkedReceipt(jsonObject(oldBytes), oldPaths);
    if (receipt.patchedHash !== LEGACY_PATCH_SHA256) throw new Error("Unknown legacy patch checksum");
    return { paths: oldPaths, receipt, legacy: true };
  }
  return { paths, receipt: newBytes ? checkedReceipt(jsonObject(newBytes), paths) : null, legacy: false };
}

export async function readVerifiedOriginal(appDirectory, userHome) {
  const current = await fs.readFile(locations(appDirectory, userHome).agent);
  if (sha256(current) === ORIGINAL_SHA256) return current;
  const installed = await installationRecord(appDirectory, userHome, current);
  if (!installed.receipt || sha256(current) !== installed.receipt.patchedHash) throw new Error("Unknown Agent version or modification");
  const backup = await fs.readFile(installed.paths.backup);
  if (sha256(backup) !== ORIGINAL_SHA256) throw new Error("Original backup checksum mismatch");
  return backup;
}

export async function install({ appDirectory, userHome, sourceRoot, checkRunning = true }) {
  const paths = locations(appDirectory, userHome);
  if (checkRunning) await assertAppClosed(appDirectory);
  return withLock(paths, async () => {
    const current = await fs.readFile(paths.agent);
    const installed = await installationRecord(appDirectory, userHome, current);
    const oldPaths = legacyLocations(appDirectory, userHome);
    const receiptBytes = await optionalBytes(paths.receipt);
    const receipt = receiptBytes ? checkedReceipt(jsonObject(receiptBytes), paths) : null;
    let original = current;
    if (installed.receipt && sha256(current) === installed.receipt.patchedHash) original = await fs.readFile(installed.paths.backup);
    const candidate = patchBundle(original);
    const migrating = installed.legacy && sha256(current) === LEGACY_PATCH_SHA256;
    if (sha256(current) !== candidate.originalHash && sha256(current) !== candidate.patchedHash && !migrating) {
      throw new Error("Installed Agent differs from both verified original and patch. No files changed.");
    }
    const configBefore = await optionalBytes(paths.config);
    const configAfter = jsonBytes(migrateRegistration(jsonObject(configBefore), paths, oldPaths));
    const bridge = await fs.readFile(path.join(sourceRoot, "plugins", "zcode-unrestricted", "native", "bridge.cjs"));
    new vm.Script(bridge.toString("utf8"), { filename: "zcode-unrestricted-native/bridge.cjs" });
    const previousBridge = await optionalBytes(path.join(paths.bridgeRoot, "bridge.cjs"));
    const previousBinding = await optionalBytes(path.join(paths.bridgeRoot, "binding.json"));
    const oldBridge = migrating ? await optionalBytes(path.join(oldPaths.bridgeRoot, "bridge.cjs")) : null;
    const oldBinding = migrating ? await optionalBytes(path.join(oldPaths.bridgeRoot, "binding.json")) : null;
    if (migrating && (!oldBridge || !oldBinding || sha256(oldBridge) !== installed.receipt.bridgeHash ||
        sha256(oldBinding) !== installed.receipt.bindingHash)) throw new Error("Legacy bridge/binding checksum mismatch");
    const legacyPrompt = await optionalBytes(oldPaths.prompt);
    const priorBackup = await optionalBytes(paths.backup);
    if (priorBackup && sha256(priorBackup) !== ORIGINAL_SHA256) throw new Error("Original backup checksum mismatch");
    if (!priorBackup) await atomicWrite(paths.backup, original);
    const nextReceipt = jsonBytes({
      version: 1, pluginVersion: VERSION, desktopVersion: SUPPORTED_DESKTOP,
      agent: paths.agent, pluginRoot: paths.pluginRoot, userHome,
      originalHash: candidate.originalHash, patchedHash: candidate.patchedHash,
      bridgeHash: sha256(bridge), bindingHash: sha256(bindingBytes(paths)),
      installedAt: receipt?.installedAt ?? new Date().toISOString(), anchors: candidate.anchors,
      ...(migrating ? { migratedFrom: LEGACY_PLUGIN_ID } : {}),
    });
    await atomicWrite(paths.receipt, nextReceipt);
    let configWritten = false;
    try {
      await copyPlugin(sourceRoot, paths, bridge, legacyPrompt);
      await compareAndWrite(paths.config, configBefore, configAfter);
      configWritten = true;
      // 最后写 Agent，之前任何准备失败都不会启用不完整的桥接。
      if (sha256(await fs.readFile(paths.agent)) !== sha256(current)) throw new Error("Agent changed during install");
      if (!current.equals(candidate.bytes)) await atomicWrite(paths.agent, candidate.bytes);
      if (sha256(await fs.readFile(paths.agent)) !== candidate.patchedHash) throw new Error("Installed patch verification failed");
      if (migrating) {
        await compareAndRemove(path.join(oldPaths.bridgeRoot, "bridge.cjs"), oldBridge);
        await compareAndRemove(path.join(oldPaths.bridgeRoot, "binding.json"), oldBinding);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const rollback of [
        () => restoreOwned(paths.agent, current, candidate.bytes),
        ...(configWritten ? [() => restoreOwned(paths.config, configBefore, configAfter)] : []),
        () => restoreOwned(path.join(paths.bridgeRoot, "bridge.cjs"), previousBridge, bridge),
        () => restoreOwned(path.join(paths.bridgeRoot, "binding.json"), previousBinding, bindingBytes(paths)),
        () => restoreOwned(paths.receipt, receiptBytes, nextReceipt),
        ...(migrating ? [
          () => restoreOwned(path.join(oldPaths.bridgeRoot, "bridge.cjs"), oldBridge, null),
          () => restoreOwned(path.join(oldPaths.bridgeRoot, "binding.json"), oldBinding, null),
        ] : []),
      ]) {
        try { await rollback(); } catch (failure) { rollbackErrors.push(failure.message); }
      }
      if (rollbackErrors.length) throw new Error(`${error.message}; rollback needs attention: ${rollbackErrors.join("; ")}`, { cause: error });
      throw error;
    }
    return { state: "installed", version: VERSION, desktopVersion: SUPPORTED_DESKTOP, pluginId: PLUGIN_ID, promptFile: paths.prompt, pluginRoot: paths.pluginRoot, migratedLegacy: migrating, defaultEnabled: false, originalHash: candidate.originalHash, patchedHash: candidate.patchedHash };
  });
}

export async function uninstall({ appDirectory, userHome, checkRunning = true }) {
  const paths = locations(appDirectory, userHome);
  if (checkRunning) await assertAppClosed(appDirectory);
  return withLock(paths, async () => {
    const current = await fs.readFile(paths.agent);
    const installed = await installationRecord(appDirectory, userHome, current);
    const actual = installed.paths;
    const receipt = installed.receipt;
    if (!receipt) throw new Error("No installation receipt. No files changed.");
    const currentHash = sha256(current);
    const original = await fs.readFile(actual.backup);
    if (sha256(original) !== receipt.originalHash) throw new Error("Original backup checksum mismatch");
    const restore = currentHash === receipt.patchedHash;
    if (!restore && [MARKER, LEGACY_MARKER].some((marker) => current.toString("utf8").includes(marker))) throw new Error("Patched Agent has other changes; refusing to overwrite it");
    const configBefore = await optionalBytes(paths.config);
    const configAfter = jsonBytes(updateRegistration(jsonObject(configBefore), actual, false));
    await compareAndWrite(paths.config, configBefore, configAfter);
    try {
      if (sha256(await fs.readFile(paths.agent)) !== currentHash) throw new Error("Agent changed during uninstall");
      if (restore) await atomicWrite(paths.agent, original);
    } catch (error) {
      await restoreOwned(paths.config, configBefore, configAfter);
      throw error;
    }
    // 只删除明确归本插件的两个桥接文件；保留提示词、备份和 receipt 供检查。
    await fs.unlink(path.join(actual.bridgeRoot, "bridge.cjs")).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await fs.unlink(path.join(actual.bridgeRoot, "binding.json")).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return { state: "uninstalled", restored: restore, upgradedAgentKept: !restore && currentHash !== receipt.originalHash, promptFile: actual.prompt };
  });
}

export async function status({ appDirectory, userHome }) {
  const current = await optionalBytes(locations(appDirectory, userHome).agent);
  const installed = await installationRecord(appDirectory, userHome, current);
  const { paths, receipt } = installed;
  const config = jsonObject(await optionalBytes(paths.config));
  const bytes = await optionalBytes(paths.prompt);
  const bridge = await optionalBytes(path.join(paths.bridgeRoot, "bridge.cjs"));
  const binding = await optionalBytes(path.join(paths.bridgeRoot, "binding.json"));
  const mounted = !!current && !!receipt && !!bridge && !!binding && sha256(current) === receipt.patchedHash &&
    sha256(bridge) === receipt.bridgeHash && sha256(binding) === receipt.bindingHash;
  const registered = (config.plugins?.dirs ?? []).some((value) => equalPath(value, paths.pluginRoot));
  return {
    state: mounted ? (installed.legacy ? "legacy_mounted" : "mounted") : "unmounted", pluginId: paths.pluginId,
    upgradeAvailable: installed.legacy,
    userEnabled: registered && config.plugins?.enabled !== false && (config.plugins?.enabledPlugins?.[paths.pluginId] ?? true) === true,
    projectOverrides: "Check native ZCode Workspace plugin settings; lastTurn reports the last resolved session.",
    supportedDesktop: SUPPORTED_DESKTOP, originalMatches: !!current && sha256(current) === ORIGINAL_SHA256,
    bridgePresent: !!bridge,
    promptFile: paths.prompt, promptBytes: bytes?.length ?? 0, promptHash: bytes ? sha256(bytes) : null,
    lastTurn: jsonObject(await optionalBytes(paths.status)),
  };
}
