#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import manifest from "../package.json";

const [output, ...extra] = process.argv.slice(2);
if (!output || extra.length > 0) {
  throw new Error("Usage: bun scripts/pack-core.ts <output.tgz>");
}

const archive = resolve(output);
const root = resolve(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "omp-stretch-core-"));
try {
  const packaged = join(temporary, "package");
  await mkdir(packaged);
  await Promise.all([
    copyFile(join(root, "stretch-core.ts"), join(packaged, "stretch-core.ts")),
    copyFile(join(root, "LICENSE"), join(packaged, "LICENSE")),
    writeFile(join(packaged, "package.json"), JSON.stringify({
      name: "omp-stretch-core",
      version: manifest.version,
      type: "module",
      exports: "./stretch-core.ts",
      types: "./stretch-core.ts",
      license: manifest.license,
    }, null, 2) + "\n"),
  ]);
  await mkdir(dirname(archive), { recursive: true });
  execFileSync("tar", ["-czf", archive, "-C", temporary, "package"], { stdio: "inherit" });
  console.log(archive);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
