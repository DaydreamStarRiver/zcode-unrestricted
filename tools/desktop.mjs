import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { install, uninstall, status, locations } from "./install-lib.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const action = arguments_.shift() ?? "status";
let appDirectory = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Programs", "ZCode");
let asJson = false;
for (let index = 0; index < arguments_.length; index++) {
  if (arguments_[index] === "--json") asJson = true;
  else if (arguments_[index] === "--app-dir" && arguments_[index + 1]) appDirectory = path.resolve(arguments_[++index]);
  else throw new Error(`Unknown argument: ${arguments_[index]}`);
}
const options = { appDirectory, userHome: os.homedir(), sourceRoot };
try {
  let result;
  if (action === "install") result = await install(options);
  else if (action === "uninstall") result = await uninstall(options);
  else if (action === "status") result = await status(options);
  else if (action === "edit") {
    const prompt = (await status(options)).promptFile;
    await fs.access(prompt);
    spawn("notepad.exe", [prompt], { detached: true, stdio: "ignore" }).unref();
    result = { state: "editor_opened", promptFile: prompt };
  } else throw new Error("Use install, uninstall, status, or edit.");
  if (asJson || action === "status") console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`ZCode Unrestricted Desktop plugin: ${result.state}`);
    if (result.promptFile) console.log(`Prompt file: ${result.promptFile}`);
    if (action === "install") console.log("Open the ORIGINAL ZCode shortcut. Enable zcode-unrestricted in its plugin settings. Changes apply to the next turn.");
    if (action === "uninstall") console.log(result.upgradedAgentKept ? "Newer Agent kept; plugin registration removed." : "Native Agent restored; your prompt file was kept.");
  }
} catch (error) {
  console.error(`ZCode Unrestricted: ${error.message}`);
  process.exitCode = 1;
}
