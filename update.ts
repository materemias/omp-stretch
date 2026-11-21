// Update check for the omp extension: at most once a day, ask GitHub for the latest release and
// announce a newer one once per version, across every omp process. `/stretch update` installs it
// through omp's marketplace CLI and points a linked Tern plugin at the new copy, since Tern keeps
// the versioned folder a link resolved to. Only a copy under an omp plugins folder checks: a
// developer's linked checkout does not.
import { mkdirSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import pkg from "./package.json";

export const CURRENT: string = pkg.version;
const REPO = "materemias/omp-stretch";
const MARKETPLACE = "omp-stretch";
const PLUGIN_ID = `omp-stretch@${MARKETPLACE}`;
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/** Shared by every omp process: `{ checkedAt, latest?, notified? }`. */
export const UPDATE_FILE = join(homedir(), ".omp", "agent", "stretch-update.json");

type UpdateState = { checkedAt?: number; latest?: string; notified?: string };

/** `[major, minor, patch]` of `X.Y.Z` or `vX.Y.Z`; anything else, prereleases included, is undefined. */
function parseVersion(text: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? match.slice(1).map(Number) : undefined;
}

/** Whether version `a` is newer than `b`; false when either is not `X.Y.Z`. */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/**
 * On for a copy omp installed (under a `.omp/plugins` folder; marketplace installs keep `.git`, so
 * that tells nothing), off for a linked checkout and with `OMP_STRETCH_UPDATE_CHECK=0`.
 */
export function checksEnabled(env: NodeJS.ProcessEnv = process.env, dir: string = import.meta.dir): boolean {
  return env.OMP_STRETCH_UPDATE_CHECK !== "0" && insideOmpPlugins(dir);
}

/** Whether `path`, symlinks resolved, lies in an omp plugins folder, user or project scope. */
function insideOmpPlugins(path: string): boolean {
  return resolved(path).includes(`${sep}.omp${sep}plugins${sep}`);
}

function readState(file: string): UpdateState {
  try {
    const state: unknown = JSON.parse(readFileSync(file, "utf8"));
    return state && typeof state === "object" ? (state as UpdateState) : {};
  } catch {
    return {};
  }
}

/** Written whole and renamed into place, so another process never reads half a file. */
function writeState(file: string, state: UpdateState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`);
  renameSync(temp, file);
}

/** The newer release last seen, if any: for `/stretch status`. Reads only the saved state. */
export function knownUpdate(file = UPDATE_FILE, current = CURRENT): string | undefined {
  const { latest } = readState(file);
  return latest !== undefined && isNewer(latest, current) ? latest : undefined;
}

async function fetchLatest(fetcher: typeof fetch): Promise<string | undefined> {
  const response = await fetcher(LATEST_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "omp-stretch" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  const body: unknown = await response.json();
  const tag = body && typeof body === "object" && "tag_name" in body ? body.tag_name : undefined;
  return typeof tag === "string" && parseVersion(tag) ? tag.replace(/^v/, "") : undefined;
}

/**
 * Ask GitHub for the latest release unless some omp process did within the last day, and return a
 * newer version no process has announced yet; it counts as announced from then on. Offline or
 * rate-limited, it waits a day like a successful check.
 */
export async function checkForUpdate(
  opts: { file?: string; current?: string; now?: number; fetcher?: typeof fetch } = {},
): Promise<string | undefined> {
  const { file = UPDATE_FILE, current = CURRENT, now = Date.now(), fetcher = fetch } = opts;
  let state = readState(file);
  const last = state.checkedAt;
  // A clock set back, or a value that is not a time, does not hold checks off.
  if (typeof last !== "number" || last > now || now - last >= CHECK_EVERY_MS) {
    // Claim the check first, so processes starting together seldom both ask GitHub.
    state = { ...state, checkedAt: now };
    writeState(file, state);
    const latest = await fetchLatest(fetcher).catch(() => undefined);
    // Another process may have announced meanwhile.
    state = { ...readState(file), checkedAt: now, ...(latest !== undefined && { latest }) };
    writeState(file, state);
  }
  const { latest, notified } = state;
  if (latest === undefined || !isNewer(latest, current) || latest === notified) return undefined;
  writeState(file, { ...state, notified: latest });
  return latest;
}

type ExecResult = { stdout: string; stderr: string; code: number };
type Exec = (command: string, args: string[]) => Promise<ExecResult>;

/** omp itself when this runs inside its binary, else `omp` on PATH. */
const OMP = basename(process.execPath).startsWith("omp") ? process.execPath : "omp";

/** The command's output, or an error naming the command and what it printed. */
async function run(exec: Exec, command: string, args: string[]): Promise<string> {
  let result: ExecResult;
  try {
    result = await exec(command, args);
  } catch (error) {
    throw new Error(`${basename(command)} ${args.join(" ")} failed: ${String(error)}`);
  }
  if (result.code !== 0) {
    const said = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
    throw new Error(`${basename(command)} ${args.join(" ")} failed${said ? `: ${said}` : ""}`);
  }
  return result.stdout;
}

/** Where omp installed the marketplace plugin, and its version, as `omp plugin list --json` reports. */
async function installed(exec: Exec): Promise<{ path: string; version: string }> {
  const list = JSON.parse(await run(exec, OMP, ["plugin", "list", "--json"])) as {
    marketplace?: { id: string; entries: { scope: string; installPath: string; version: string }[] }[];
  };
  const entries = list.marketplace?.find(plugin => plugin.id === PLUGIN_ID)?.entries ?? [];
  const entry = entries.find(e => e.scope === "user") ?? entries[0];
  if (!entry) throw new Error(`${PLUGIN_ID} is not installed from omp's marketplace; update it where you installed it`);
  return { path: entry.installPath, version: entry.version };
}

/**
 * Install the latest release: refresh the marketplace catalog, upgrade the plugin, then relink a
 * Tern plugin linked into omp's plugin folder. Returns what to tell the reader; throws when the
 * upgrade fails, while a failed relink after it only adds a line.
 */
export async function installUpdate(exec: Exec): Promise<string> {
  const before = await installed(exec);
  await run(exec, OMP, ["plugin", "marketplace", "update", MARKETPLACE]);
  await run(exec, OMP, ["plugin", "upgrade", PLUGIN_ID]);
  const now = await installed(exec);
  // An install this process has not loaded yet, from this upgrade or an earlier one, needs a restart.
  const lines = [
    now.version === before.version && now.version === CURRENT
      ? `omp-stretch ${CURRENT} is already the latest.`
      : `omp-stretch ${now.version} is installed; restart omp to load it.`,
  ];
  // A Tern link keeps the versioned folder it resolved to. Relink only one into omp's plugins, not a
  // developer's checkout; an installed copy updates itself through `tern plugin install`.
  let ternDir: string | undefined;
  try {
    ternDir = (await run(exec, "tern", ["plugin", "dir"])).trim();
  } catch {
    return lines.join("\n");
  }
  const linkFile = join(ternDir, "omp-stretch.path");
  if (!existsSync(linkFile)) return lines.join("\n");
  const linked = readFileSync(linkFile, "utf8").trim();
  const target = join(now.path, "tern-plugin");
  if (!insideOmpPlugins(linked) || resolved(linked) === resolved(target)) return lines.join("\n");
  try {
    await run(exec, "tern", ["plugin", "link", target]);
    lines.push("The Tern plugin now links to it.");
  } catch (error) {
    lines.push(`Relinking the Tern plugin failed (${errorText(error)}); run: tern plugin link ${target}`);
  }
  return lines.join("\n");
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `path` with symlinks resolved, or as given when it is gone. */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
