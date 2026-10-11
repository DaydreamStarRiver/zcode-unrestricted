import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function optionalBytes(file) {
  try { return await fs.readFile(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export function jsonObject(bytes) {
  if (bytes === null) return {};
  const value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Config must be a JSON object");
  return value;
}
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
export async function atomicWrite(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, bytes, { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}
export async function compareAndWrite(file, expected, replacement) {
  const actual = await optionalBytes(file);
  if (expected === null ? actual !== null : actual === null || !actual.equals(expected)) {
    throw new Error("Config changed concurrently; retry after saving ZCode settings.");
  }
  await atomicWrite(file, replacement);
}

export async function restoreOwned(file, previous, written) {
  const current = await optionalBytes(file);
  const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b);
  if (equal(current, previous)) return;
  if (!equal(current, written)) throw new Error(`File changed during rollback: ${path.basename(file)}`);
  if (previous === null) await fs.unlink(file);
  else await atomicWrite(file, previous);
}

export async function compareAndRemove(file, expected) {
  const current = await optionalBytes(file);
  if (!current || !expected || !current.equals(expected)) throw new Error(`File changed during cleanup: ${path.basename(file)}`);
  await fs.unlink(file);
}
