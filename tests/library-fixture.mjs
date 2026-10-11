import vm from "node:vm";
import os from "node:os";
import { createRequire } from "node:module";
import { agentFile, patched } from "./native-fixture.mjs";

// 在沙箱中加载真实 bundle 的模块定义，明确移除 CLI main 的初始化和调用。
// 原生 config/schema/plugin adapter/builder 均保留；禁止网络和子进程。
export function nativeLibrary(userHome, workspace, bridge) {
  const agentRequire = createRequire(agentFile);
  const realProcess = process;
  const processFacade = Object.create(realProcess);
  Object.assign(processFacade, {
    env: { ...realProcess.env, HOME: userHome, USERPROFILE: userHome }, argv: [process.execPath, agentFile],
    cwd: () => workspace, on: () => processFacade, once: () => processFacade,
    exit: () => { throw new Error("CLI exit prohibited in library fixture"); },
  });
  const require = (specifier) => {
    if (specifier === "./zcode-unrestricted-native/bridge.cjs") return bridge;
    if (specifier === "node:os") return { ...os, homedir: () => userHome };
    if (/^(node:)?(http|https|net|tls|child_process)$/.test(specifier)) {
      const module = { ...agentRequire(specifier) };
      const functions = /child_process/.test(specifier)
        ? ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]
        : ["request", "get", "connect", "createConnection", "createServer"];
      for (const name of functions) if (name in module) module[name] = () => { throw new Error("Network/subprocess prohibited in library fixture"); };
      return module;
    }
    return agentRequire(specifier);
  };
  const sandbox = vm.createContext({
    require, module: { exports: {} }, exports: {}, __filename: agentFile, __dirname: agentFile.replace(/[\\/][^\\/]+$/, ""),
    process: processFacade, Buffer, console, TextEncoder, TextDecoder, AbortController, AbortSignal,
    URL, URLSearchParams, Blob, FormData, Headers, Request, Response, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
    fetch: () => { throw new Error("Network prohibited in library fixture"); },
  });
  const source = patched.bytes.toString("utf8");
  const marker = "Dqt();Ioc();async function Ioc()";
  if (source.split(marker).length !== 2) throw new Error("CLI entry anchor changed");
  const library = source.replace(marker, "async function Ioc()");
  vm.runInContext(library + '\n_Hr();GOe();Ahn();globalThis.nativeLibrary={createConfig:K0,createPluginAdapter:Xzs,createBuilder:Ehn};', sandbox, { timeout: 15000 });
  return sandbox.nativeLibrary;
}
