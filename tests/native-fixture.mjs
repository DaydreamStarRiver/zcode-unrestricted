import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { patchBundle, PATCHES, ORIGINAL_SHA256, sha256 } from "../tools/patch.mjs";
import { jsonBytes } from "../tools/files.mjs";
import { readVerifiedOriginal } from "../tools/install-lib.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const agentFile = path.join(process.env.LOCALAPPDATA, "Programs", "ZCode", "resources", "glm", "zcode.cjs");
export async function readOriginalAgent(file, userHome = os.homedir()) {
  return readVerifiedOriginal(path.resolve(path.dirname(file), "../.."), userHome);
}
export const original = await readOriginalAgent(agentFile);
export const patched = patchBundle(original);
const require = createRequire(import.meta.url);
export const { createBridge, PLUGIN_ID, MAX_PROMPT_BYTES } = require("../plugins/zcode-unrestricted/native/bridge.cjs");

export async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-unrestricted-test-"));
  t.after(async () => {
    // 每次只清理本测试创建、已经解析并校验的临时目录。
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("zcode-unrestricted-test-")) throw new Error("Unsafe temporary cleanup");
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

export async function publicSourceFixture(directory) {
  const sourceRoot = path.join(directory, "public-package");
  for (const relative of [".zcode-plugin/plugin.json", "README.md", "native/bridge.cjs", "prompts/example-system.md"]) {
    const destination = path.join(sourceRoot, "plugins/zcode-unrestricted", relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, "plugins/zcode-unrestricted", relative), destination);
  }
  return sourceRoot;
}

export async function bridgeFixture(t, prompt = "MY SYSTEM") {
  const directory = await temporary(t);
  const pluginRoot = path.join(directory, "plugin");
  await fs.mkdir(path.join(pluginRoot, ".zcode-plugin"), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, ".zcode-plugin", "plugin.json"), jsonBytes({ name: "zcode-unrestricted" }));
  const promptFile = path.join(directory, "system.md");
  await fs.writeFile(promptFile, prompt);
  const binding = { version: 1, pluginId: PLUGIN_ID, pluginRoot, promptFile, statusFile: path.join(directory, "status.json") };
  const bridge = createBridge(binding);
  const config = { enabled: true, dirs: [pluginRoot], enabledPlugins: { [PLUGIN_ID]: true }, options: {} };
  const load = () => ({ config: { plugins: config } });
  return { directory, binding, bridge, config, load, promptFile };
}

function segment(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing verified native fixture: ${start}`);
  return source.slice(from, to);
}

export function nativeFunctions(bridge, load) {
  const source = patched.bytes.toString("utf8");
  const helperCode = segment(source, "function QKs(", "var Thn,XKs,INe,Ahn=");
  const builderCode = segment(source, "INe=class{static{r(this,\"ContextBuilder\")}", ";r(QKs,");
  const factoryCode = segment(source, "function VCo(", "async function HCo(");
  const refreshCode = segment(source, "function v4(", "var sve=");
  const stage = segment(source, PATCHES[1].after, ',kt=rt("session_start_hooks")');
  const section = (source, content, injectionTarget = "system", cacheHint = "stable") => ({
    name: source, source, content, injectionTarget, cacheHint, chars: content.length, tokens: Math.ceil(content.length / 4),
  });
  // 执行原 bundle 的 builder/排序/消息组装/factory/refresh/turn-context 阶段。
  // 外部 section 内容、模型/工具依赖受控替换；不启动 CLI、不请求真实模型。
  const context = vm.createContext({
    __zcodeUnrestrictedBridge: bridge, K0: load, r: (value) => value, wm: (value) => Math.ceil(value.length / 4),
    hNe: () => section("cli_prefix", "You are ZCode ORIGINAL PREFIX"),
    Qmn: () => section("identity", "ORIGINAL IDENTITY"),
    whn: () => section("desktop", "ORIGINAL DESKTOP"), jno: () => section("behavior", "ORIGINAL BEHAVIOR"),
    Fno: () => section("guidance", "ORIGINAL GUIDANCE"), bhn: () => section("memory", "ORIGINAL MEMORY"),
    nhn: () => section("environment", "ORIGINAL ENVIRONMENT"), Bno: () => null,
    Uno: () => section("context_management", "ORIGINAL CONTEXT RULES"), rhn: () => null,
    gNe: () => section("skills", "SKILLS META", "meta_user"),
    Pdt: () => section("instructions", "USER AGENTS META", "meta_user"),
    kNe: () => section("date", "DATE META", "meta_user", "dynamic"),
    ehn: () => section("workflow", "WORKFLOW IDENTITY"), ave: () => false, UG: {},
    hwn: (config) => ({ build: () => ({ systemMessages: [{ role: "system", content: config.agentPrompt }], metaUserAttachments: [], sections: [] }) }),
    A_t: (result) => [
      ...result.systemMessages.map((message) => ({ ...message, prefix: true })),
      ...result.metaUserAttachments.map((attachment) => ({ role: "user", content: attachment.content, prefix: true })),
    ],
    oT: (entries) => { const index = entries.findIndex((entry) => !entry.prefix); return index < 0 ? entries.length : index; },
  });
  vm.runInContext(`var Thn={type:"ephemeral"},XKs="Skill",INe;${helperCode}${builderCode};${factoryCode}${refreshCode}
    async function nativeTurnContext(){const l=null,u=null,b={},U=this.abortSignal,St=this.model;
      const rt=()=>0,Pe=()=>{},jd=(signal)=>signal?.throwIfAborted();${stage};}
    globalThis.exports={Builder:INe,factory:VCo,refresh:v4,stage:nativeTurnContext};`, context);
  return context.exports;
}

export function runtimeFixture(functions, workspace) {
  let entries = [];
  const warnings = [];
  const tools = [
    { name: "Read", inputSchema: { type: "object", properties: { filePath: { type: "string" } } } },
    { name: "Skill", inputSchema: { type: "object", properties: { skill: { type: "string" } } } },
  ];
  const runtime = {
    sessionId: "offline-test", workspaceRoot: workspace, workingDirectory: workspace,
    config: { presentationSurface: "zcode_desktop", taskType: "interactive", systemPrompt: undefined },
    logger: { warn: (message, data) => warnings.push({ message, data }) },
    contextInitialized: false, registry: { marker: "ORIGINAL TOOLS" }, skillLoadOutcome: { skills: [] },
    getTools: () => tools, createContextBuilderFromSnapshot: functions.factory,
    createConfigOnlyContextSnapshot: () => ({ workingDirectory: workspace, envInfo: { platform: "win32" }, currentDate: "2026-10-11" }),
    messageHistory: { borrowReadOnlyRuntimeEntries: () => entries, replaceMessages: (value) => { entries = value; } },
    async ensureContextInitialized() {
      this.contextSourceSnapshot = this.createConfigOnlyContextSnapshot();
      this.contextBuilder = this.createContextBuilderFromSnapshot(this.contextSourceSnapshot);
      this.contextInitialized = true;
      functions.refresh(this);
    },
  };
  return { runtime, tools, warnings, history: () => entries };
}
