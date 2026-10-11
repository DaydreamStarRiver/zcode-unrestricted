import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { bridgeFixture, nativeFunctions, runtimeFixture, root, PLUGIN_ID, MAX_PROMPT_BYTES } from "./native-fixture.mjs";

test("actual patched native turn/factory/builder replaces all system sections, preserves meta and tools", async (t) => {
  const fixture = await bridgeFixture(t);
  const functions = nativeFunctions(fixture.bridge, fixture.load);
  const { runtime, tools, history } = runtimeFixture(functions, fixture.directory);
  await functions.stage.call(runtime);
  runtime.contextBuilder.addSection({ source: "extra_native", content: "OTHER ORIGINAL SYSTEM", cacheHint: "stable" });
  const result = runtime.contextBuilder.build();
  assert.equal(result.systemMessages.length, 1);
  assert.equal(result.systemMessages[0].content.trim(), "MY SYSTEM");
  assert.ok(!result.sections.some((item) => item.source === "cli_prefix" || item.source === "extra_native"));
  assert.ok(result.metaUserAttachments.some((item) => item.content.includes("SKILLS META")));
  assert.ok(result.metaUserAttachments.some((item) => item.content.includes("USER AGENTS META")));
  assert.equal(result.totalChars, result.sections.reduce((sum, section) => sum + section.chars, 0));
  assert.equal(result.totalTokens, result.sections.reduce((sum, section) => sum + section.tokens, 0));
  assert.equal(runtime.getTools(), tools);
  assert.ok(history().some((item) => item.role === "system" && item.content.includes("MY SYSTEM")));
  assert.equal(runtime.config.systemPrompt, undefined);
});

test("native prefix refresh restores configured SDK baseline and retains tool/assistant history", async (t) => {
  const fixture = await bridgeFixture(t);
  const functions = nativeFunctions(fixture.bridge, fixture.load);
  const { runtime, history } = runtimeFixture(functions, fixture.directory);
  runtime.config.systemPrompt = "SDK BASELINE";
  await functions.stage.call(runtime);
  const messages = [
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "Read", input: { filePath: "a" } }] },
    { role: "tool", toolCallId: "call-1", content: "RESULT" }, { role: "user", content: "continue" },
  ];
  runtime.messageHistory.replaceMessages([...history(), ...messages]);
  fixture.config.enabledPlugins[PLUGIN_ID] = false;
  await functions.stage.call(runtime);
  assert.deepEqual(JSON.parse(JSON.stringify(history().filter((item) => !item.prefix))), messages);
  const system = history().filter((item) => item.role === "system").map((item) => item.content).join("\n");
  assert.match(system, /SDK BASELINE/);
  assert.match(system, /ORIGINAL PREFIX/);
  assert.doesNotMatch(system, /MY SYSTEM/);
  assert.equal(runtime.config.systemPrompt, "SDK BASELINE");
});

test("busy toggles and edited prompt remain frozen through native refresh, apply next turn", async (t) => {
  const fixture = await bridgeFixture(t, "FIRST");
  const functions = nativeFunctions(fixture.bridge, fixture.load);
  const { runtime, history } = runtimeFixture(functions, fixture.directory);
  await functions.stage.call(runtime);
  await fs.writeFile(fixture.promptFile, "SECOND");
  fixture.config.enabledPlugins[PLUGIN_ID] = false;
  functions.refresh(runtime);
  assert.equal(history().find((item) => item.role === "system").content.trim(), "FIRST");
  await functions.stage.call(runtime);
  assert.match(history().find((item) => item.role === "system").content, /ORIGINAL PREFIX/);
  fixture.config.enabledPlugins[PLUGIN_ID] = true;
  await functions.stage.call(runtime);
  assert.equal(history().find((item) => item.role === "system").content.trim(), "SECOND");
});

test("a synthetic 38 KiB UTF-8 prompt is not truncated and status has no prompt content", async (t) => {
  const prompt = Buffer.from("汉".repeat(12000) + "A".repeat(2260), "utf8");
  assert.equal(prompt.length, 38260);
  const fixture = await bridgeFixture(t, prompt);
  const functions = nativeFunctions(fixture.bridge, fixture.load);
  const { runtime } = runtimeFixture(functions, fixture.directory);
  await functions.stage.call(runtime);
  assert.equal(runtime.contextBuilder.build().systemMessages[0].content.trim(), prompt.toString("utf8").trim());
  const status = JSON.parse(await fs.readFile(fixture.binding.statusFile, "utf8"));
  assert.equal(status.state, "active");
  assert.match(status.revision, /^[a-f0-9]{64}$/);
  assert.equal(status.scope, "last-turn");
  assert.ok(!("prompt" in status));
});

test("native effective workspace settings win; relative file uses initial root after cd", async (t) => {
  const fixture = await bridgeFixture(t);
  const initial = path.join(fixture.directory, "workspace");
  await fs.mkdir(initial);
  await fs.writeFile(path.join(initial, "project-system.md"), "PROJECT OVERRIDE");
  let workspaceEnabled = false;
  const nativeLoad = () => ({ config: { plugins: { ...fixture.config, enabledPlugins: { [PLUGIN_ID]: workspaceEnabled }, options: { [PLUGIN_ID]: { promptFile: "project-system.md" } } } } });
  const functions = nativeFunctions(fixture.bridge, nativeLoad);
  const { runtime, history } = runtimeFixture(functions, initial);
  await functions.stage.call(runtime);
  assert.match(history().find((item) => item.role === "system").content, /ORIGINAL/);
  workspaceEnabled = true;
  runtime.workingDirectory = path.join(fixture.directory, "elsewhere");
  await functions.stage.call(runtime);
  assert.equal(history().find((item) => item.role === "system").content.trim(), "PROJECT OVERRIDE");
});

test("invalid, empty, missing and oversized prompts restore baseline without logging text", async (t) => {
  const fixture = await bridgeFixture(t);
  const functions = nativeFunctions(fixture.bridge, fixture.load);
  const { runtime, history, warnings } = runtimeFixture(functions, fixture.directory);
  for (const [value, code] of [[Buffer.from([0xff, 0xfe]), "invalid_utf8"], [" \n", "empty_prompt"], [Buffer.alloc(MAX_PROMPT_BYTES + 1, 65), "oversize"], [null, "ENOENT"]]) {
    await fs.writeFile(fixture.promptFile, "VALID BEFORE ERROR");
    await functions.stage.call(runtime);
    if (value === null) await fs.unlink(fixture.promptFile); else await fs.writeFile(fixture.promptFile, value);
    await functions.stage.call(runtime);
    assert.match(history().find((item) => item.role === "system").content, /ORIGINAL PREFIX/);
    const status = JSON.parse(await fs.readFile(fixture.binding.statusFile, "utf8"));
    assert.equal(status.state, "error");
    assert.equal(status.code, code);
  }
  assert.doesNotMatch(JSON.stringify(warnings), /VALID BEFORE ERROR|MY SYSTEM/);
});

test("removed registration, missing manifest and master switch stop overrides", async (t) => {
  const fixture = await bridgeFixture(t);
  const functions = nativeFunctions(fixture.bridge, fixture.load);
  const { runtime, history } = runtimeFixture(functions, fixture.directory);
  await functions.stage.call(runtime);
  fixture.config.enabled = false;
  await functions.stage.call(runtime);
  assert.match(history().find((item) => item.role === "system").content, /ORIGINAL/);
  fixture.config.enabled = true;
  fixture.config.dirs = [];
  await functions.stage.call(runtime);
  assert.match(history().find((item) => item.role === "system").content, /ORIGINAL/);
  fixture.config.dirs = [fixture.binding.pluginRoot];
  await fs.unlink(path.join(fixture.binding.pluginRoot, ".zcode-plugin/plugin.json"));
  await functions.stage.call(runtime);
  assert.match(history().find((item) => item.role === "system").content, /ORIGINAL/);
});

test("child/workflow/CLI runtimes are excluded; snapshots are isolated per runtime", async (t) => {
  const fixture = await bridgeFixture(t);
  const functions = nativeFunctions(fixture.bridge, fixture.load);
  const { runtime } = runtimeFixture(functions, fixture.directory);
  await functions.stage.call(runtime);
  const second = runtimeFixture(functions, fixture.directory).runtime;
  assert.equal(fixture.bridge.contextConfig(second, { customSystemPrompt: "OWN" }).customSystemPrompt, "OWN");
  for (const config of [{ taskType: "subagent_child" }, { workflowActor: {} }, { subagentContext: { agentPrompt: "CHILD" } }, { presentationSurface: "zcode_cli" }]) {
    const excluded = runtimeFixture(functions, fixture.directory).runtime;
    Object.assign(excluded.config, config);
    let loaded = false;
    await fixture.bridge.beginTurn(excluded, {}, undefined, () => { loaded = true; return fixture.load(); });
    assert.equal(loaded, false);
    const originalConfig = { customSystemPrompt: "OWN", workflowActor: config.workflowActor };
    assert.equal(fixture.bridge.contextConfig(excluded, originalConfig), originalConfig);
  }
});

test("cancelled turn does not initialize/rebuild context or swallow abort", async (t) => {
  const fixture = await bridgeFixture(t);
  const functions = nativeFunctions(fixture.bridge, fixture.load);
  const { runtime } = runtimeFixture(functions, fixture.directory);
  const controller = new AbortController();
  controller.abort();
  runtime.abortSignal = controller.signal;
  await assert.rejects(functions.stage.call(runtime), { name: "AbortError" });
  assert.equal(runtime.contextInitialized, false);
});
