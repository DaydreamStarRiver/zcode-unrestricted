import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function walk(directory) {
  let files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (["runtime", "zocde-old", "artifacts", "dist", ".git"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (/\.(mjs|cjs)$/.test(entry.name)) files.push(file);
    else if (entry.name.endsWith(".json")) JSON.parse(await fs.readFile(file, "utf8"));
    else if (entry.name.endsWith(".cmd")) {
      const bytes = await fs.readFile(file);
      if (bytes.some((value) => value > 127)) throw new Error(`CMD must be ASCII: ${file}`);
    }
  }
  return files;
}
const files = await walk(root);
await Promise.all(files.map((file) => execute(process.execPath, ["--check", file], { windowsHide: true })));
console.log(`Syntax/JSON/CMD checks passed (${files.length} JavaScript files).`);
