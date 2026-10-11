import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { temporary, root, original } from "./native-fixture.mjs";
import { install, locations } from "../tools/install-lib.mjs";

test("running target process blocks installation without killing it or changing files", async (t) => {
  const directory = await temporary(t);
  const appDirectory = path.join(directory, "fake-ZCode");
  const userHome = path.join(directory, "user");
  const paths = locations(appDirectory, userHome);
  await fs.mkdir(paths.glm, { recursive: true });
  await fs.writeFile(paths.agent, original);
  const executable = path.join(appDirectory, "ZCode.exe");
  // 测试专用 Node 副本，只运行 IPC/计时器；不启动真正桌面客户端。
  await fs.copyFile(process.execPath, executable);
  const child = spawn(executable, ["-e", "process.send('ready');setInterval(()=>{},1000)"], {
    windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Test helper did not start")), 10000);
      child.once("message", () => { clearTimeout(timer); resolve(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    await assert.rejects(install({ appDirectory, userHome, sourceRoot: root }), /Close ZCode completely/);
    assert.equal(child.exitCode, null);
    assert.deepEqual(await fs.readFile(paths.agent), original);
    await assert.rejects(fs.access(paths.config), { code: "ENOENT" });
    await assert.rejects(fs.access(paths.receipt), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
