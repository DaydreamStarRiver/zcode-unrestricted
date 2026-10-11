"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const PLUGIN_ID = "zcode-unrestricted@inline";
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAIN_TASKS = new Set([undefined, "interactive", "fork", "selection_side_chat"]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  const result = path.resolve(value);
  return process.platform === "win32" ? result.toLowerCase() : result;
};

async function boundedText(file, limit, signal) {
  signal?.throwIfAborted();
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    signal?.throwIfAborted();
    if (size > limit) throw Object.assign(new Error("File exceeds limit"), { code: "oversize" });
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    } catch {
      throw Object.assign(new Error("Invalid UTF-8"), { code: "invalid_utf8" });
    }
  } finally {
    await handle.close();
  }
}

function eligible(runtime) {
  return runtime.config.presentationSurface === "zcode_desktop" &&
    MAIN_TASKS.has(runtime.config.taskType) &&
    !runtime.config.subagentContext && !runtime.config.workflowActor;
}

function validateBinding(binding) {
  if (!record(binding) || binding.version !== 1 || binding.pluginId !== PLUGIN_ID ||
      !path.isAbsolute(binding.pluginRoot ?? "") || !path.isAbsolute(binding.promptFile ?? "") ||
      !path.isAbsolute(binding.statusFile ?? "")) {
    throw Object.assign(new Error("Invalid bridge binding"), { code: "binding_invalid" });
  }
  return binding;
}

function createBridge(binding) {
  const snapshots = new WeakMap();

  async function publish(runtime, snapshot) {
    if (!binding || !path.isAbsolute(binding.statusFile ?? "")) return;
    // 状态只描述最后解析的 turn，不泄露正文、API key 或整份原生配置。
    const status = {
      version: 1,
      pluginId: PLUGIN_ID,
      observedAt: new Date().toISOString(),
      scope: "last-turn",
      sessionId: runtime.sessionId,
      workspace: runtime.workspaceRoot ?? runtime.workingDirectory,
      state: snapshot.state,
      ...(snapshot.code ? { code: snapshot.code } : {}),
      ...(snapshot.revision ? { revision: snapshot.revision } : {}),
    };
    const temporary = `${binding.statusFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(binding.statusFile), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, binding.statusFile);
    } catch {
      await fs.unlink(temporary).catch(() => {});
      runtime.logger?.warn("ZCode Unrestricted status write failed", { event: "zcode-unrestricted.status.failed" });
    }
  }

  async function beginTurn(runtime, trace, signal, loadNativeConfig) {
    signal?.throwIfAborted();
    snapshots.set(runtime, Object.freeze({ state: "off" }));
    // 首版只处理本地桌面普通主会话，子代理/工作流仍走自己的上下文构建器。
    if (!eligible(runtime)) return;
    let snapshot;
    try {
      validateBinding(binding);
      const result = await loadNativeConfig();
      signal?.throwIfAborted();
      const config = result.config?.plugins;
      if (!record(config)) throw Object.assign(new Error("Invalid native config"), { code: "config_invalid" });
      const registered = Array.isArray(config.dirs) && config.dirs.some(
        (directory) => typeof directory === "string" && canonical(directory) === canonical(binding.pluginRoot),
      );
      const enabled = config.enabled !== false && registered &&
        (config.enabledPlugins?.[PLUGIN_ID] ?? true) === true;
      if (!enabled) {
        snapshot = Object.freeze({ state: "off" });
      } else {
        const manifestText = await boundedText(
          path.join(binding.pluginRoot, ".zcode-plugin", "plugin.json"), MAX_MANIFEST_BYTES, signal,
        );
        const manifest = JSON.parse(manifestText);
        if (manifest.name !== "zcode-unrestricted") {
          throw Object.assign(new Error("Plugin manifest changed"), { code: "manifest_invalid" });
        }
        const option = config.options?.[PLUGIN_ID]?.promptFile;
        if (option !== undefined && typeof option !== "string") {
          throw Object.assign(new Error("Invalid prompt path"), { code: "prompt_path_invalid" });
        }
        const rawPath = option?.trim();
        const promptFile = rawPath ? path.resolve(runtime.workspaceRoot ?? runtime.workingDirectory, rawPath) : binding.promptFile;
        const prompt = await boundedText(promptFile, MAX_PROMPT_BYTES, signal);
        if (!prompt.trim()) throw Object.assign(new Error("Empty prompt"), { code: "empty_prompt" });
        snapshot = Object.freeze({ state: "active", prompt, revision: digest(prompt) });
      }
    } catch (error) {
      signal?.throwIfAborted();
      const code = ["oversize", "invalid_utf8", "binding_invalid", "config_invalid", "manifest_invalid", "prompt_path_invalid", "empty_prompt", "ENOENT", "EACCES"].includes(error?.code)
        ? error.code : "resolve_failed";
      snapshot = Object.freeze({ state: "error", code });
      runtime.logger?.warn("ZCode Unrestricted override unavailable; using native system", {
        event: "zcode-unrestricted.override.failed", code, ...(trace?.turnId ? { turnId: trace.turnId } : {}),
      });
    }
    signal?.throwIfAborted();
    snapshots.set(runtime, snapshot);
    await publish(runtime, snapshot);
    signal?.throwIfAborted();
  }

  function contextConfig(runtime, config) {
    const snapshot = snapshots.get(runtime);
    return eligible(runtime) && snapshot?.state === "active"
      ? { ...config, customSystemPrompt: snapshot.prompt, __zcodeUnrestrictedReplaceSystem: true }
      : config;
  }

  function filterSections(config, sections) {
    if (!config.__zcodeUnrestrictedReplaceSystem) return sections;
    // 原生 custom 分支仍保留 CLI prefix；在统计前一起去掉，避免“替换”变成拼接。
    let keptPrompt = false;
    return sections.filter((section) => {
      if (section.injectionTarget !== "system") return true;
      if (section.source !== "custom_system_prompt" || keptPrompt) return false;
      keptPrompt = true;
      return true;
    });
  }

  return { beginTurn, contextConfig, filterSections };
}

let binding = null;
try { binding = require("./binding.json"); } catch { /* 未安装时不覆盖原生配置。 */ }
module.exports = { ...createBridge(binding), createBridge, PLUGIN_ID, MAX_PROMPT_BYTES };
