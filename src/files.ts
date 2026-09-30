import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function relativeName(name: string) {
  if (
    !name ||
    path.isAbsolute(name) ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error(`Invalid relative path: ${name}`);
  return name;
}
export async function checkedFile(root: string, name: string) {
  relativeName(name);
  let current = root;
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Symbolic links are not allowed");
  for (const part of name.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Symbolic links are not allowed");
  }
  if (!(await lstat(current)).isFile())
    throw new Error(`Expected a regular file: ${name}`);
  return current;
}
export async function readJson<T>(root: string, name: string): Promise<T> {
  return JSON.parse(await readFile(await checkedFile(root, name), "utf8"));
}
export async function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function withLock<T>(rootInput: string, fn: () => Promise<T>) {
  const root = await realpath(rootInput);
  const lock = path.join(root, ".lock");
  try {
    await writeFile(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Task is already running. After an interrupted run, confirm its process has exited before removing .lock.",
      );
    throw e;
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}
export async function snapshotFiles(
  root: string,
  maxFiles = Infinity,
  maxBytes = Infinity,
  maxFileBytes: (name: string) => number = () => Infinity,
) {
  const files: { name: string; data: Buffer; sha256: string }[] = [];
  let totalBytes = 0;
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Symbolic links are not allowed");
  async function visit(dir: string) {
    for (const e of (
      await readdir(path.join(root, dir), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(dir, e.name);
      if (e.isSymbolicLink())
        throw new Error(`Symbolic links are not allowed：${name}`);
      if (e.isDirectory()) await visit(name);
      else {
        const file = await checkedFile(root, name);
        if ((await lstat(file)).size > Math.min(maxBytes, maxFileBytes(name)))
          throw new Error(`File exceeds the configured size limit: ${name}`);
        const data = await readFile(file);
        files.push({ name, data, sha256: hash(data) });
        totalBytes += data.length;
        if (files.length > maxFiles || totalBytes > maxBytes)
          throw new Error(
            "Task exceeds the configured size limit; split it into smaller modules",
          );
      }
    }
  }
  await visit("");
  return files;
}
export async function copyFiles(
  root: string,
  files: { name: string; data: Buffer }[],
) {
  for (const f of files) {
    relativeName(f.name);
    const dest = path.join(root, f.name);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, f.data, { flag: "wx" });
  }
}
