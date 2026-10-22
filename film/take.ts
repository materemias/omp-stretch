// Films one take: a real omp with stretch.ts, in a real Tern window that loads the Tern plugin, answered
// by fake-model.ts. The window runs on a private daemon with a scratch copy of your Tern settings, so
// your own window, sessions and settings stay out of it. Tern can't record a window, so a loop of
// `tern ctl shot` takes ~20 frames a second; the frames, the pointer moves, the clicks and the
// captions go to WORK/timeline.json for compose.py.
//   bun film/take.ts [WORK]   (default /tmp/omp-film)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LIGHT_QUESTION, QUESTION } from "./script.ts";

const REPO = resolve(import.meta.dir, "..");
const WORK = resolve(process.argv[2] ?? "/tmp/omp-film");
const PORT = 4599;
const SOCK = join(WORK, "win.sock");
const SHOTS = join(WORK, "target/shots/tern/live");
const SIZE = [880, 620] as const;
// Font 16 scales Tern's chrome too: these are its title bar and bottom bar, which compose.py drops.
const FONT = 16;
const CROP = [6, 48, SIZE[0] - 6, SIZE[1] - 34] as const;
const CLICKS = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "omp-stretch");

rmSync(WORK, { recursive: true, force: true });
const agent = join(WORK, "home/.omp/agent");
mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, "models.yml"), `providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:${PORT}\n    apiKey: x\n`);
writeFileSync(
  join(agent, "config.yml"),
  `setupVersion: 2\nmodelRoles:\n  default: anthropic/claude-opus-5-5\nsymbolPreset: nerd\nhideThinkingBlock: true\nstartup:\n  changelogMode: "off"\nmarketplace:\n  autoUpdate: "off"\n`,
);
writeFileSync(join(agent, "stretch.json"), `{"mode":"dense"}`);
// The film hides Tern's banners and the pane's alert glow: omp's "Finished" banner would cover the
// reply. Tern's own rules win over a bare `#banners`, hence the long selector and !important.
writeFileSync(
  join(WORK, "film.css"),
  `div#banners.tn-bn-stack, div#banners.tn-bn-stack > div.tn-bn { display: none !important; }\n.tn-glow { display: none !important; }\n`,
);

// Font 16 is a setting, so the window gets its own config: your settings.json and this plugin's link.
const config = join(WORK, "tern-config");
mkdirSync(join(config, "plugins"), { recursive: true });
const userConfig = process.env.TERN_CONFIG_DIR ?? join(homedir(), ".config/tern");
copyFileSync(join(userConfig, "settings.json"), join(config, "settings.json"));
writeFileSync(join(config, "plugins/omp-stretch.path"), join(REPO, "tern-plugin"));
// `ctl run` takes one word. HOME points omp at the film's home, so /stretch light stays out of yours.
writeFileSync(
  join(WORK, "omp.sh"),
  `#!/bin/sh\ncd ${REPO} && HOME=${join(WORK, "home")} exec omp --no-session --model anthropic/claude-opus-5-5 -e ${join(REPO, "stretch.ts")}\n`,
  { mode: 0o755 },
);
const sleep = (ms: number) => Bun.sleep(ms);
const t0 = performance.now();
const now = () => performance.now() - t0;

async function ctl(...args: string[]): Promise<any> {
  const p = Bun.spawn(["tern", "ctl", "--control", SOCK, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const line = out.split("\n").find((l) => l.startsWith("{"));
  const reply = line ? JSON.parse(line) : { ok: false, error: out };
  if (!reply.ok) throw new Error(`ctl ${args.join(" ")}: ${reply.error}`);
  return reply;
}

const env = { ...process.env, TERN_DAEMON_SOCKET: join(WORK, "d.sock"), TERN_CONFIG_DIR: config };
const procs = [
  Bun.spawn(["bun", join(REPO, "film/fake-model.ts"), String(PORT)], { stdout: "ignore", stderr: "inherit" }),
  Bun.spawn(["tern", "daemon", "--socket", env.TERN_DAEMON_SOCKET], { env, stdout: "ignore", stderr: "ignore" }),
];
await sleep(1500);
procs.push(Bun.spawn(["tern", "--control", SOCK], { cwd: WORK, env, stdout: "ignore", stderr: "ignore" }));
for (let i = 0; !existsSync(SOCK); i++) {
  if (i > 100) throw new Error("the window never opened its control socket");
  await sleep(100);
}

type Event = { t: number; kind: "move"; x: number; y: number } | { t: number; kind: "click" | "caption"; text?: string };
const frames: { t: number; file: string }[] = [];
const events: Event[] = [];
let filming = false;
let pointer = { x: 0, y: 0 };

async function shoot() {
  for (let n = 0; filming; n++) {
    const t = now();
    const file = `f${String(n).padStart(5, "0")}`;
    await ctl("shot", file);
    frames.push({ t, file: join(SHOTS, `${file}.png`) });
    await sleep(Math.max(0, 50 - (now() - t)));
  }
}

const caption = (text: string) => events.push({ t: now(), kind: "caption", text });

async function glide(x: number, y: number, ms = 350) {
  const from = pointer;
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    pointer = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
    await ctl("move", pointer.x.toFixed(1), pointer.y.toFixed(1));
    events.push({ t: now(), kind: "move", ...pointer });
    await sleep(ms / steps);
  }
}

type Link = { text: string; rect: [number, number, number, number] };
async function link(pick: (links: Link[]) => Link | undefined, what: string): Promise<Link> {
  const links = (await ctl("tree", "a")).nodes as Link[];
  const found = pick(links);
  if (!found) throw new Error(`no link ${what} on screen; links: ${JSON.stringify(links.map((l) => l.text))}`);
  return found;
}
const startingWith = (text: string) => (links: Link[]) => links.find((l) => l.text.startsWith(text));

/** Glides to a link, rests on it so its dotted underline shows, and clicks it. */
async function press(l: Link) {
  const [x, y, w, h] = l.rect;
  const at = { x: x + Math.min(w * 0.4, 90), y: y + h / 2 };
  await glide(at.x, at.y);
  await sleep(450);
  await ctl("click", at.x.toFixed(1), at.y.toFixed(1));
  events.push({ t: now(), kind: "click" });
}

async function typeOut(text: string) {
  for (const ch of text) {
    await ctl("type", JSON.stringify(ch));
    await sleep(12);
  }
}

try {
  await ctl("ready");
  await ctl("resize", String(SIZE[0]), String(SIZE[1]));
  await ctl("font", String(FONT));
  await ctl("css", "omp-film", join(WORK, "film.css"));
  await ctl("run", join(WORK, "omp.sh"));
  await sleep(9000);
  pointer = { x: SIZE[0] * 0.62, y: SIZE[1] * 0.72 };
  await ctl("move", String(pointer.x), String(pointer.y));

  filming = true;
  const loop = shoot();
  events.push({ t: now(), kind: "move", ...pointer });
  caption("With /stretch dense, a reply shows each paragraph's gist.");
  await sleep(400);
  await typeOut(QUESTION);
  await sleep(250);
  await ctl("key", "Enter");
  await sleep(3000);

  caption("Click a phrase. It stretches in place.");
  await press(await link(startingWith("Rebase replays"), "for stretch 1"));
  await sleep(1200);

  caption("Stretches nest. The words you already read stay put.");
  await press(await link(startingWith("Each replayed commit"), "for stretch 2"));
  await sleep(700);
  await press(await link(startingWith("a hash covers its parent"), "for the nested stretch"));
  await sleep(1500);

  caption("Click « and it shrinks back.");
  await press(await link((ls) => ls.find((l) => l.text.trim() === "«"), "« for stretch 1"));
  await sleep(1100);

  // Stretch 1 is closed now, so the only ✦ left ends the nested stretch.
  caption("Click the star for more. The model writes it in place.");
  await press(await link((ls) => ls.find((l) => l.text.trim() === "✦"), "✦ after the nested stretch"));
  await sleep(4500);
  await press(await link(startingWith("one changed commit"), "for the stretch in the ✦ answer"));
  await sleep(1500);

  caption("/stretch light keeps a sentence or two in view.");
  await glide(SIZE[0] * 0.62, SIZE[1] * 0.72, 250);
  await typeOut("/stretch light");
  await sleep(300);
  await ctl("key", "Enter");
  await sleep(500);
  await typeOut(LIGHT_QUESTION);
  await sleep(250);
  await ctl("key", "Enter");
  await sleep(3800);

  filming = false;
  await loop;
  writeFileSync(join(WORK, "timeline.json"), JSON.stringify({ crop: CROP, frames, events }, null, 1));
  const seconds = (frames.at(-1)!.t - frames[0].t) / 1000;
  console.log(`${frames.length} frames over ${seconds.toFixed(1)} s -> ${join(WORK, "timeline.json")}`);
} finally {
  filming = false;
  // The take's omp runs under the private daemon and made a click directory named after its pid.
  // Collect the daemon's descendants before it goes, and remove only their directories.
  const film: number[] = [];
  for (let todo = [procs[1].pid]; todo.length > 0; ) {
    const pid = todo.pop()!;
    film.push(pid);
    try {
      for (const task of readdirSync(`/proc/${pid}/task`)) {
        const children = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim();
        if (children) todo.push(...children.split(/\s+/).map(Number));
      }
    } catch {
      // The process or one of its threads exited while being read; it has no children left to find.
    }
  }
  await ctl("quit").catch(() => {});
  for (const p of procs) p.kill();
  for (const pid of film) rmSync(join(CLICKS, String(pid)), { recursive: true, force: true });
}
