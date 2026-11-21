import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, checksEnabled, installUpdate, isNewer, knownUpdate } from "./update.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-stretch-update-"));
  file = join(dir, "stretch-update.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A GitHub API stand-in answering `tag`, counting its calls. */
function github(tag: string | Error) {
  const fake = Object.assign(
    async () => {
      fake.calls++;
      if (tag instanceof Error) throw tag;
      return Response.json({ tag_name: tag });
    },
    { calls: 0 },
  );
  return fake as unknown as typeof fetch & { calls: number };
}

test("versions compare numerically, and prereleases never count as newer", () => {
  expect(isNewer("0.10.0", "0.9.9")).toBe(true);
  expect(isNewer("v1.0.0", "0.9.0")).toBe(true);
  expect(isNewer("0.6.0", "0.6.0")).toBe(false);
  expect(isNewer("0.5.9", "0.6.0")).toBe(false);
  expect(isNewer("0.7.0-beta.1", "0.6.0")).toBe(false);
});

test("a newer release is announced once, and GitHub is asked at most once a day", async () => {
  const fetcher = github("v0.7.0");
  const day = 24 * 60 * 60 * 1000;
  expect(await checkForUpdate({ file, current: "0.6.0", now: 0, fetcher })).toBe("0.7.0");
  expect(await checkForUpdate({ file, current: "0.6.0", now: day - 1, fetcher })).toBeUndefined();
  expect(fetcher.calls).toBe(1);
  expect(knownUpdate(file, "0.6.0")).toBe("0.7.0");
  expect(await checkForUpdate({ file, current: "0.6.0", now: day, fetcher })).toBeUndefined();
  expect(fetcher.calls).toBe(2);
});

test("the next release is announced again; an installed one is not", async () => {
  const day = 24 * 60 * 60 * 1000;
  await checkForUpdate({ file, current: "0.6.0", now: 0, fetcher: github("v0.7.0") });
  expect(await checkForUpdate({ file, current: "0.6.0", now: day, fetcher: github("v0.8.0") })).toBe("0.8.0");
  expect(knownUpdate(file, "0.8.0")).toBeUndefined();
});

test("offline, the check keeps the last known release and waits a day", async () => {
  const day = 24 * 60 * 60 * 1000;
  await checkForUpdate({ file, current: "0.6.0", now: 0, fetcher: github("v0.7.0") });
  const offline = github(new Error("offline"));
  expect(await checkForUpdate({ file, current: "0.6.0", now: day, fetcher: offline })).toBeUndefined();
  expect(await checkForUpdate({ file, current: "0.6.0", now: day + 1, fetcher: offline })).toBeUndefined();
  expect(offline.calls).toBe(1);
  expect(knownUpdate(file, "0.6.0")).toBe("0.7.0");
});

test("a copy omp installed checks, git clone or not; a linked checkout does not", () => {
  const installed = join(dir, ".omp", "plugins", "cache", "plugins", "omp-stretch___omp-stretch___0.6.0");
  mkdirSync(join(installed, ".git"), { recursive: true });
  expect(checksEnabled({}, installed)).toBe(true);
  expect(checksEnabled({ OMP_STRETCH_UPDATE_CHECK: "0" }, installed)).toBe(false);
  expect(checksEnabled({}, join(dir, "code", "omp-stretch"))).toBe(false);
});

/** omp and tern stand-ins: omp-stretch moves from 0.6.0 to 0.7.0 on upgrade; `fail` names a step that fails. */
function tools(linkedTo: string, fail?: "upgrade" | "link") {
  const plugins = join(dir, ".omp", "plugins", "cache", "plugins");
  const ternDir = join(dir, "tern-plugins");
  mkdirSync(ternDir, { recursive: true });
  writeFileSync(join(ternDir, "omp-stretch.path"), `${linkedTo}\n`);
  let version = "0.6.0";
  const calls: string[] = [];
  const exec = async (command: string, args: string[]) => {
    const line = `${command.endsWith("tern") ? "tern" : "omp"} ${args.join(" ")}`;
    calls.push(line);
    const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });
    if (line === "omp plugin list --json") {
      const installPath = join(plugins, `omp-stretch___omp-stretch___${version}`);
      return ok(JSON.stringify({ marketplace: [{ id: "omp-stretch@omp-stretch", entries: [{ scope: "user", installPath, version }] }] }));
    }
    if (line.startsWith("omp plugin upgrade")) {
      if (fail === "upgrade") return { stdout: "", stderr: "Failed to upgrade: network", code: 1 };
      version = "0.7.0";
    }
    if (line === "tern plugin dir") return ok(ternDir);
    if (line.startsWith("tern plugin link") && fail === "link") return { stdout: "", stderr: "daemon down", code: 1 };
    return ok();
  };
  return { exec, calls, newPlugin: join(plugins, "omp-stretch___omp-stretch___0.7.0", "tern-plugin") };
}

test("an update relinks a Tern plugin linked into omp's plugins", async () => {
  const old = join(dir, ".omp", "plugins", "cache", "plugins", "omp-stretch___omp-stretch___0.6.0", "tern-plugin");
  const { exec, calls, newPlugin } = tools(old);
  expect(await installUpdate(exec)).toBe("omp-stretch 0.7.0 is installed; restart omp to load it.\nThe Tern plugin now links to it.");
  expect(calls).toContain(`tern plugin link ${newPlugin}`);
});

test("an update leaves a Tern plugin linked to a checkout alone", async () => {
  const { exec, calls } = tools(join(dir, "code", "omp-stretch", "tern-plugin"));
  expect(await installUpdate(exec)).toBe("omp-stretch 0.7.0 is installed; restart omp to load it.");
  expect(calls.some(call => call.startsWith("tern plugin link"))).toBe(false);
});

test("a failed relink still reports the installed update", async () => {
  const old = join(dir, ".omp", "plugins", "cache", "plugins", "omp-stretch___omp-stretch___0.6.0", "tern-plugin");
  const { exec, newPlugin } = tools(old, "link");
  const said = await installUpdate(exec);
  expect(said).toStartWith("omp-stretch 0.7.0 is installed; restart omp to load it.\nRelinking the Tern plugin failed");
  expect(said).toEndWith(`run: tern plugin link ${newPlugin}`);
});

test("a failed upgrade throws with what omp printed", async () => {
  const { exec } = tools("", "upgrade");
  await expect(installUpdate(exec)).rejects.toThrow("Failed to upgrade: network");
});
