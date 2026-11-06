// Films the plain-terminal take: a real omp with stretch.ts in a real kitty, picking stretches with
// omp's link hint key (Alt+O), answered by fake-model.ts. kitty runs on a private Xvfb display, so
// your desktop, sessions and settings stay out of it, and ffmpeg records that display; its frames,
// the key presses and the captions go to WORK/timeline.json for compose.py.
//   bun film/take-plain.ts [WORK]   (default /tmp/omp-film-plain)
//   uv run film/compose.py WORK stretch-plain
import type { Subprocess } from "bun";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIGHT_QUESTION, QUESTION } from "./script.ts";

const REPO = resolve(import.meta.dir, "..");
const WORK = resolve(process.argv[2] ?? "/tmp/omp-film-plain");
const PORT = 4599;
// 880x460 after the crop fills compose.py's page at scale 1.
const SIZE = [880, 466] as const;
// kitty draws a bar along the window's top edge once omp runs; the crop leaves it out.
const CROP = [0, 6, SIZE[0], SIZE[1]] as const;
const FPS = 20;
const SOCK = `unix:${join(WORK, "kitty.sock")}`;

rmSync(WORK, { recursive: true, force: true });
const agent = join(WORK, "home/.omp/agent");
mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, "models.yml"), `providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:${PORT}\n    apiKey: x\n`);
writeFileSync(
  join(agent, "config.yml"),
  `setupVersion: 2\nmodelRoles:\n  default: anthropic/claude-opus-5-5\nsymbolPreset: nerd\nhideThinkingBlock: true\nstartup:\n  changelogMode: "off"\nmarketplace:\n  autoUpdate: "off"\nextensionRenderers:\n  assistantText: true\n`,
);
writeFileSync(join(agent, "stretch.json"), `{"mode":"dense"}`);
// HOME points omp at the film's home, so /stretch light and the default keys stay out of yours.
writeFileSync(
  join(WORK, "omp.sh"),
  `#!/bin/sh\ncd ${REPO} && HOME=${join(WORK, "home")} exec omp --no-session --model anthropic/claude-opus-5-5 -e ${join(REPO, "stretch.ts")}\n`,
  { mode: 0o755 },
);

const sleep = (ms: number) => Bun.sleep(ms);
let t0 = performance.now();
const now = () => performance.now() - t0;

// Outside Tern: no Tern variables reach omp, or stretch.ts would take the Tern path. DISPLAY is set
// once Xvfb has picked a free display.
const env: Record<string, string | undefined> = { ...process.env };
for (const name of ["TERN_PANE", "TERN_SOCKET", "OMPCODE", "PI_SESSION_FILE", "PI_SESSION_ID", "PI_TOOL_CALL_ID", "WAYLAND_DISPLAY"])
  delete env[name];

async function kitty(...args: string[]): Promise<string> {
  const p = Bun.spawn(["kitty", "@", "--to", SOCK, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`kitty @ ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out;
}

type Event = { t: number; kind: "caption" | "key"; text: string };
const events: Event[] = [];
const caption = (text: string) => events.push({ t: now(), kind: "caption", text });

async function key(name: string, shown: string) {
  events.push({ t: now(), kind: "key", text: shown });
  await kitty("send-key", name);
}

async function typeOut(text: string) {
  for (const ch of text) {
    await kitty("send-text", "--", ch);
    await sleep(12);
  }
}

/** One screen row as drawn: its plain text, and the runs drawn in reverse video (the hint tags). */
type Row = { text: string; tags: { col: number; text: string }[] };

async function screen(): Promise<Row[]> {
  const raw = await kitty("get-text", "--ansi");
  return raw.split("\n").map((line) => {
    // Hyperlinks and other OSC strings carry no cells.
    const clean = line.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
    let text = "";
    let reverse = false;
    const tags: Row["tags"] = [];
    for (let i = 0; i < clean.length; ) {
      const sgr = /^\x1b\[([0-9;:]*)m/.exec(clean.slice(i));
      if (sgr) {
        const params = sgr[1].split(";");
        for (let p = 0; p < params.length; p++) {
          const param = params[p];
          // An extended colour takes the next parameters as its arguments: 38;5;n or 38;2;r;g;b.
          if (param === "38" || param === "48" || param === "58") p += params[p + 1] === "5" ? 2 : params[p + 1] === "2" ? 4 : 0;
          else if (param === "" || param === "0" || param === "27") reverse = false;
          else if (param === "7") reverse = true;
        }
        i += sgr[0].length;
        continue;
      }
      if (reverse) {
        const last = tags.at(-1);
        if (last && last.col + last.text.length === text.length) last.text += clean[i];
        else tags.push({ col: text.length, text: clean[i] });
      }
      text += clean[i];
      i++;
    }
    return { text, tags };
  });
}

/** A label's spot before tags cover it: its row's text and its column. */
type Spot = { text: string; col: number };

/** Where `label` starts inside `context`, the lowest one on screen. */
async function find(label: string, context = label): Promise<Spot> {
  const rows = await screen();
  for (const r of rows.toReversed()) {
    const at = r.text.lastIndexOf(context);
    if (at >= 0) return { text: r.text, col: at + context.indexOf(label) };
  }
  throw new Error(`"${context}" is not on screen:\n${rows.map((r) => r.text.trimEnd()).join("\n")}`);
}

/**
 * The tag drawn over a spot once hint mode is on. The hint status line can scroll the transcript
 * up a row, so the spot's row is found again by its text: the same, but where tags cover it.
 */
async function tagAt(spot: Spot): Promise<string> {
  for (let i = 0; i < 20; i++) {
    for (const r of await screen()) {
      if (r.text.length !== spot.text.length) continue;
      const covered = (col: number) => r.tags.some((t) => col >= t.col && col < t.col + t.text.length);
      let same = true;
      for (let col = 0; same && col < r.text.length; col++) same = r.text[col] === spot.text[col] || covered(col);
      if (!same) continue;
      const tag = r.tags.find((t) => t.col === spot.col);
      if (tag) return tag.text;
    }
    await sleep(100);
  }
  throw new Error(`no tag at column ${spot.col} of "${spot.text.trimEnd()}"`);
}

/** The tag over a label shown with tags on: its first letters are covered, the rest still reads. */
async function tagOver(label: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    for (const r of await screen()) {
      for (const t of r.tags) {
        const rest = r.text.slice(t.col + t.text.length);
        if (label.length > t.text.length && rest.startsWith(label.slice(t.text.length))) return t.text;
      }
    }
    await sleep(100);
  }
  throw new Error(`no tag over "${label}"`);
}

/** Alt+O, a pause on the tags, then the tag over `label` (inside `context`, when it repeats). */
async function pick(label: string, o: { context?: string; tagsCaption?: string; pickCaption?: string } = {}) {
  const spot = await find(label, o.context);
  if (o.tagsCaption) caption(o.tagsCaption);
  await key("alt+o", "Alt+O");
  const tag = await tagAt(spot);
  await sleep(o.pickCaption ? 1100 : 800);
  if (o.pickCaption) caption(o.pickCaption);
  events.push({ t: now(), kind: "key", text: tag });
  await typeOut(tag);
}

const procs: Subprocess[] = [];
let recorder: Subprocess<"pipe"> | undefined;

try {
  procs.push(Bun.spawn(["bun", join(REPO, "film/fake-model.ts"), String(PORT)], { stdout: "ignore", stderr: "inherit" }));
  // Xvfb picks a free display and writes its number, so the take never draws on a display in use.
  const xvfb = Bun.spawn(["Xvfb", "-displayfd", "1", "-screen", "0", `${SIZE[0]}x${SIZE[1]}x24`, "-nolisten", "tcp"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  procs.push(xvfb);
  const reader = xvfb.stdout.getReader();
  let number = "";
  while (!number.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Xvfb exited before it opened a display");
    number += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const display = `:${number.trim()}`;
  env.DISPLAY = display;
  await sleep(300);
  procs.push(
    Bun.spawn(
      [
        "kitty",
        "-o", "linux_display_server=x11",
        "-o", "allow_remote_control=yes",
        "-o", `initial_window_width=${SIZE[0]}`,
        "-o", `initial_window_height=${SIZE[1]}`,
        "-o", "remember_window_size=no",
        "-o", "hide_window_decorations=yes",
        "-o", "background_opacity=1",
        "-o", "font_size=12",
        "-o", "window_padding_width=8",
        "--listen-on", SOCK,
        "--directory", REPO,
        join(WORK, "omp.sh"),
      ],
      { env, stdout: "ignore", stderr: "ignore" },
    ),
  );
  await sleep(10000);

  const frames = join(WORK, "frames");
  mkdirSync(frames);
  recorder = Bun.spawn(
    ["ffmpeg", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(FPS), "-video_size", `${SIZE[0]}x${SIZE[1]}`, "-i", display, join(frames, "%05d.png")],
    { env, stdin: "pipe", stdout: "ignore", stderr: "inherit" },
  );
  // x11grab's first frame comes a moment after the spawn; the timeline starts with it.
  for (let i = 0; readdirSync(frames).length === 0; i++) {
    if (i > 100) throw new Error("ffmpeg never wrote a frame");
    await sleep(10);
  }
  t0 = performance.now() - 1000 / FPS;

  caption("In a plain terminal, a reply shows each paragraph's gist.");
  await sleep(400);
  await typeOut(QUESTION);
  await sleep(250);
  await key("enter", "Enter");
  await sleep(3000);

  await pick("Rebase replays", {
    tagsCaption: "Alt+O puts a letter on each stretch.",
    pickCaption: "Type a letter. That stretch opens in place.",
  });
  await sleep(1400);

  caption("Stretches nest. The words you already read stay put.");
  await pick("Each replayed commit");
  await sleep(900);
  await pick("a hash covers its parent");
  await sleep(1500);

  caption("Its « shrinks it back.");
  await pick("«", { context: "main. ✦ «" });
  await sleep(1200);

  // Stretch 1 is closed now; this ✦ ends the nested stretch.
  caption("Its star asks the model for more, written in place.");
  await pick("✦", { context: "message ✦" });
  await sleep(4800);
  await pick("one changed commit");
  await sleep(1500);

  caption("/stretch light keeps a sentence or two in view.");
  await typeOut("/stretch light");
  await sleep(300);
  await key("enter", "Enter");
  await sleep(500);
  await typeOut(LIGHT_QUESTION);
  await sleep(250);
  await key("enter", "Enter");
  await sleep(3800);

  caption("Alt+O twice reaches stretches above the screen.");
  await key("alt+o", "Alt+O");
  await sleep(700);
  await key("alt+o", "Alt+O");
  await sleep(1100);
  // The first reply's top has scrolled off; Page Up brings it into the browser's view.
  await key("page_up", "PgUp");
  await sleep(1100);
  const first = await tagOver("Rebase replays");
  events.push({ t: now(), kind: "key", text: first });
  await typeOut(first);
  await sleep(1800);
  await key("escape", "Esc");
  await sleep(1500);

  recorder.stdin!.write("q");
  recorder.stdin!.end();
  await recorder.exited;
  const files = readdirSync(frames).sort();
  writeFileSync(
    join(WORK, "timeline.json"),
    JSON.stringify(
      { crop: CROP, frames: files.map((f, n) => ({ t: (n * 1000) / FPS, file: join(frames, f) })), events },
      null,
      1,
    ),
  );
  console.log(`${files.length} frames over ${(files.length / FPS).toFixed(1)} s -> ${join(WORK, "timeline.json")}`);
} finally {
  recorder?.kill();
  for (const p of procs.reverse()) p.kill();
}
