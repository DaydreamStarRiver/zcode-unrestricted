import { createHash } from "node:crypto";
import vm from "node:vm";

export const VERSION = "0.3.0";
export const ORIGINAL_SHA256 = "fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f";
export const SUPPORTED_DESKTOP = "3.14.4.7912";
export const MARKER = "/* ZCODE_UNRESTRICTED_DESKTOP_BRIDGE_v1 */";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const loader = `${MARKER}var __zcodeUnrestrictedBridge=(()=>{try{return require("./zcode-unrestricted-native/bridge.cjs")}catch{return{beginTurn:async()=>{},contextConfig:(e,t)=>t,filterSections:(e,t)=>t}}})();`;
export const PATCHES = [
  {
    name: "bridge_loader",
    before: '#!/usr/bin/env node\n"use strict";',
    after: '#!/usr/bin/env node\n"use strict";' + loader,
  },
  {
    name: "turn_snapshot",
    before: 'let kt=rt("context_initialization");this.contextInitialized?v4(this,{model:St})',
    after: 'if(l===null&&u===null)await __zcodeUnrestrictedBridge.beginTurn(this,b,U,()=>K0({workingDirectory:this.workspaceRoot??this.workingDirectory}));let kt=rt("context_initialization");this.contextInitialized?v4(this,{model:St})',
  },
  {
    name: "context_config",
    before: 'return Ehn(s).setToolRegistry(this.registry)}async function HCo(e)',
    after: 'return Ehn(__zcodeUnrestrictedBridge.contextConfig(this,s)).setToolRegistry(this.registry)}async function HCo(e)',
  },
  {
    name: "system_sections",
    before: 't.push(...this.customSections);let g=QKs(t),_=g.reduce((I,E)=>I+E.chars,0)',
    after: 't.push(...this.customSections);let g=QKs(__zcodeUnrestrictedBridge.filterSections(this.config,t)),_=g.reduce((I,E)=>I+E.chars,0)',
  },
];

export function patchBundle(original) {
  if (sha256(original) !== ORIGINAL_SHA256) throw new Error("Unsupported Agent SHA-256. No files changed.");
  let code = original.toString("utf8");
  if (code.includes("__zcodeUnrestrictedBridge") || code.includes(MARKER)) throw new Error("Unexpected existing ZCode Unrestricted patch");
  for (const patch of PATCHES) {
    if (code.split(patch.before).length !== 2) throw new Error(`Patch anchor not unique: ${patch.name}`);
    code = code.replace(patch.before, patch.after);
  }
  // 只编译，不执行 Agent；保证接线不破坏当前 bundle 的 JavaScript 语法。
  new vm.Script(code, { filename: "zcode.cjs" });
  const patched = Buffer.from(code, "utf8");
  return { bytes: patched, originalHash: sha256(original), patchedHash: sha256(patched), anchors: PATCHES.map((item) => item.name) };
}
