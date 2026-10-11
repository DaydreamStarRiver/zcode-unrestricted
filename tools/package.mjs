import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VERSION } from "./patch.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
await fs.mkdir(dist, { recursive: true });
const staging = await fs.mkdtemp(path.join(dist, ".zcode-unrestricted-package-"));
const destination = path.join(dist, `zcode-unrestricted-desktop-${VERSION}.zip`);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
try {
  // 公共交付使用明确清单；Git ignore 不能阻止 fs.cp 把私人正文装进 ZIP。
  const files = [
    "install.cmd", "uninstall.cmd", "status.cmd", "edit-prompt.cmd", "README.md", "package.json", "LICENSE",
    ...["design", "validation", "usage", "project-layout"].map((name) => `docs/${name}.md`),
    "plugins/zcode-unrestricted/.zcode-plugin/plugin.json", "plugins/zcode-unrestricted/README.md",
    "plugins/zcode-unrestricted/native/bridge.cjs", "plugins/zcode-unrestricted/prompts/example-system.md",
  ];
  for (const directory of ["tools", "tests"]) {
    for (const name of await fs.readdir(path.join(root, directory))) if (name.endsWith(".mjs")) files.push(`${directory}/${name}`);
  }
  for (const name of ["node.exe", "NODE-LICENSE"]) {
    const relative = `tools/runtime/${name}`;
    try { await fs.access(path.join(root, relative)); files.push(relative); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const file of files) {
    const target = path.join(staging, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, file), target);
  }
  await fs.unlink(destination).catch((error) => { if (error.code !== "ENOENT") throw error; });
  const command = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);[void][System.Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem');[System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(staging)},${quote(destination)},[System.IO.Compression.CompressionLevel]::Optimal,$false)`;
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 120000 });
  console.log(destination);
} finally {
  if (path.dirname(path.resolve(staging)) !== path.resolve(dist) || !path.basename(staging).startsWith(".zcode-unrestricted-package-")) throw new Error("Unsafe staging cleanup");
  await fs.rm(staging, { recursive: true, force: true });
}
