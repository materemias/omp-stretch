// Stretchtext replies for omp in Tern, after pro-vi/cc-stretch (MIT): the model writes
// `{{short|long}}`, the chat shows each short form as a link, and a click grows it in place.
//
// omp gives extensions no hook into how a reply is drawn, so this patches
// AssistantMessageComponent.updateContent to rewrite the displayed text; the session keeps the
// model's markup as written. Clicks reach omp through the `omp-stretch` Tern plugin
// (tern-plugin/), which claims links to cc-stretch.invalid and drops each as a file in this
// process's click directory. Outside Tern no click lands, so stretches are drawn open and the model
// is not asked to write them.
import {
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
  canDeepen,
  type DeepenAnswer,
  deepenNote,
  deepenPrompt,
  DEEPEN,
  DEEPEN_REPORTED,
  spliceAnswer,
  TWINKLE_MS,
  isLinkable,
  KEY_SEPARATOR,
  lengthOf,
  type Mode,
  type LinkOp,
  linkedMarkdown,
  parse,
  promptTransition,
  streamingView,
  type Stretch,
  stretches,
  withAnswers,
  writeOpen,
} from "./stretch-core.ts";

// An internal omp module, served to extensions only from omp 18.11.0. On an older or restructured
// omp the extension does nothing: no guide, so the model writes no stretches it cannot show.
const Component: typeof AssistantMessageComponent | undefined = await import(
  "@oh-my-pi/pi-tui/chat/assistant-message"
).then(
  module =>
    typeof module.AssistantMessageComponent?.prototype?.updateContent === "function"
      ? module.AssistantMessageComponent
      : undefined,
  () => undefined,
);

const NOTE_TYPE = "cc-stretch.read";
/** Session entry holding one ✦ answer: `{ block, key, text }`, never sent to the model. */
const DEEPEN_TYPE = "omp-stretch.deepen";
/** Output tokens a ✦ press may use, reasoning included, on transports that honour a cap. */
const DEEPEN_MAX_TOKENS = 1500;
const HREF = `https://cc-stretch.invalid/${process.pid}/`;
// Without XDG_RUNTIME_DIR, one folder per user in /tmp, so one user's 0700 folder never locks out another.
// The Tern plugin builds the same path.
const CLICK_ROOT = process.env.XDG_RUNTIME_DIR
  ? join(process.env.XDG_RUNTIME_DIR, "omp-stretch")
  : `/tmp/omp-stretch-${process.env.USER ?? ""}`;
const CLICK_DIR = join(CLICK_ROOT, String(process.pid));
const CLICKABLE = process.env.TERN_PANE !== undefined;
const FRAME_MS = 33;

/** A text block of one reply: `${message.timestamp}.${contentIndex}`, the index in the whole reply. */
type BlockId = string;

type Growth = { timestamp: number; block: BlockId; key: string; start: number; duration: number };
type Content = AssistantMessage["content"];

/**
 * State shared by every session of this process and by every import of this file: a reload imports
 * the file again, while the prototype patch and the click watcher belong to the process.
 */
type Shared = {
  /** Stretch keys drawn open, per block. */
  openKeys: Map<BlockId, Set<string>>;
  /** `${blockId}\0${key}` of every stretch the reader opened; what the next note reports. */
  seen: Set<string>;
  /** Final replies with stretches on screen, by timestamp: the whole reply and the components drawing it. */
  shown: Map<number, { message: AssistantMessage; components: WeakRef<AssistantMessageComponent>[] }>;
  /**
   * The part of its reply each component draws. omp draws a reply with tool calls as one component per
   * segment, each holding only its own blocks under the reply's timestamp.
   */
  segments: WeakMap<AssistantMessageComponent, AssistantMessage>;
  /** Whole replies by timestamp, from `message_end` and the session branch, to count block indexes in. */
  replies: Map<number, AssistantMessage>;
  /** Content this patch drew, mapped to the content it was drawn from. */
  sources: WeakMap<Content, Content>;
  /** The main session's branch, to find a reply drawn from history. */
  branch?: () => readonly unknown[];
  /** Set once the exit hook that removes the click directory is registered. */
  exitHook?: boolean;
  growing?: Growth;
  /**
   * Set by `/stretch off|light|dense`; unset means `dense`. `off`: no guide, no read note, and
   * stretches already written are drawn open.
   */
  mode?: Mode;
  requestRender?: () => void;
  watcher?: FSWatcher;
  /** omp's own method while the patch is installed. */
  original?: AssistantMessageComponent["updateContent"];
  /** For tern-awui's tern-mobile extension, while the patch is installed: see `bridge` below. */
  bridge?: StretchBridge;
  /** ✦ answers per block, spliced into the block's text before it is parsed. */
  answers: Map<BlockId, DeepenAnswer[]>;
  /** Each ✦ press still waiting, by `${blockId}\0${key}`: when it started and the answer so far. */
  running: Map<string, { start: number; partial: string }>;
  /**
   * Answers the current session's next note must report: the model never saw them. Rebuilt from the
   * session on every start and switch, so they never reach another session and survive a restart.
   */
  deepened: { section: string; text: string }[];
  /** The main session's side turn, its entry writer and its toasts; unset outside the main Tern TUI. */
  ask?: (promptText: string, onDelta: (delta: string) => void, signal: AbortSignal) => Promise<string>;
  save?: (entry: { block: BlockId; section: string } & DeepenAnswer) => void;
  warn?: (message: string) => void;
  /** Aborted when the main session or its branch changes: a press running then has nowhere to land. */
  presses?: AbortController;
  /** Adds stretches written after `message_end` (inside ✦ answers) to the next read note. */
  wrote?: (written: { id: string; short: string }[]) => void;
  /** This import's click reader: the watcher outlives a reload, the reader must not. */
  drain?: () => void;
};

/**
 * What another extension in this omp process may use (tern-awui's tern-mobile, so its phone view
 * shows and opens the same stretches): the open keys per block, and opening one as a click does.
 * The ✦ fields and `deepen` are additions to version 1: a reader that predates them ignores them.
 */
type StretchBridge = {
  version: 1;
  state(): {
    off: boolean;
    open: Record<BlockId, string[]>;
    /** Whether a ✦ press can run in this session (the main Tern TUI, on an omp with side turns). */
    deepen: boolean;
    /** ✦ answers per block, in the order they were given; spliced in with `withAnswers`. */
    answers: Record<BlockId, DeepenAnswer[]>;
    /** Presses still running per block: the stretch, whole seconds waited, and the answer so far. */
    running: Record<BlockId, { key: string; seconds: number; partial: string }[]>;
  };
  setOpen(block: BlockId, key: string, open: boolean): void;
  /** Press ✦ on the stretch `key` of `block`, as a click in the pane does. */
  deepen(block: BlockId, key: string): void;
};
// A reload keeps the state an older import created: add whatever fields it predates.
const state = ((globalThis as Record<symbol, Partial<Shared> | undefined>)[Symbol.for("omp-stretch")] ??= {});
state.openKeys ??= new Map();
state.seen ??= new Set();
state.shown ??= new Map();
state.segments ??= new WeakMap();
state.replies ??= new Map();
state.sources ??= new WeakMap();
state.answers ??= new Map();
state.running ??= new Map();
state.deepened ??= [];
delete (state as { produced?: unknown }).produced;
const shared = state as Shared;
const { openKeys, seen, shown, segments, replies, sources, answers, running } = shared;
const modeOf = (): Mode => shared.mode ?? "dense";

/** One block's text with its ✦ answers spliced in; cached per answer list, which a new answer replaces. */
const splicedCache = new WeakMap<readonly DeepenAnswer[], { text: string; out: string }>();
function spliced(id: BlockId, text: string): string {
  const list = answers.get(id);
  if (list === undefined) return text;
  const hit = splicedCache.get(list);
  if (hit?.text === text) return hit.out;
  const out = withAnswers(text, list);
  splicedCache.set(list, { text, out });
  return out;
}

const hasMarkup = (content: Content) => content.some(block => block.type === "text" && block.text.includes("{{"));

/** The whole reply `segment` is part of; `segment` itself when the reply cannot be found. */
function wholeReply(segment: AssistantMessage): AssistantMessage {
  if (!replies.has(segment.timestamp)) {
    for (const entry of shared.branch?.() ?? []) {
      const message = (entry as { type?: string; message?: AssistantMessage }).message;
      if (message?.role === "assistant" && hasMarkup(message.content)) replies.set(message.timestamp, message);
    }
  }
  return replies.get(segment.timestamp) ?? segment;
}

/** `segment` as drawn; `whole` (the reply it belongs to) numbers its blocks, undefined while streaming. */
function view(segment: AssistantMessage, whole: AssistantMessage | undefined): AssistantMessage {
  const content = segment.content.map((block, i) => {
    if (block.type !== "text" || !block.text.includes("{{")) return block;
    if (whole === undefined) {
      const parts = parse(block.text);
      return stretches(parts).length === 0 ? block : { ...block, text: streamingView(parts) };
    }
    const found = whole.content.findIndex(b => b.type === "text" && b.text === block.text);
    const at = found === -1 ? i : found;
    const id: BlockId = `${segment.timestamp}.${at}`;
    const parts = parse(spliced(id, block.text));
    if (stretches(parts).length === 0) return block;
    if (!CLICKABLE || shared.mode === "off") return { ...block, text: writeOpen(parts) };
    const open = openKeys.get(id);
    const now = shared.growing?.block === id ? shared.growing : undefined;
    const text = linkedMarkdown(parts, {
      href: (op, index) => `${HREF}${op}/${segment.timestamp}/${at}/${index}`,
      isOpen: key => open?.has(key) === true,
      growing: now && { key: now.key, progress: Math.min(1, (Date.now() - now.start) / now.duration) },
      deepen: shared.ask && {
        progress: key => {
          const press = running.get(`${id}\0${key}`);
          return press && { elapsedMs: Date.now() - press.start, partial: press.partial };
        },
      },
    });
    return { ...block, text };
  });
  sources.set(content, segment.content);
  return { ...segment, content };
}

type UpdateContent = AssistantMessageComponent["updateContent"];

/** This import's `updateContent`: draws through this import's `view`, then omp's own method. */
const wrapper: UpdateContent = function (this: AssistantMessageComponent, message, opts) {
  const original = shared.original!;
  // A component redrawing what it was given (omp's retry recovery spreads its last message) draws
  // from the source again, so the drawn links are never parsed as the reply.
  const source = sources.get(message.content);
  const segment = source === undefined ? message : { ...message, content: source };
  if (!hasMarkup(segment.content)) return original.call(this, segment, opts);
  if (opts?.transient === true) return original.call(this, view(segment, undefined), opts);
  const whole = wholeReply(segment);
  segments.set(this, segment);
  const entry = shown.get(segment.timestamp);
  if (entry === undefined) shown.set(segment.timestamp, { message: whole, components: [new WeakRef(this)] });
  else {
    entry.message = whole;
    entry.components = entry.components.filter(ref => ref.deref() !== undefined && ref.deref() !== this);
    entry.components.push(new WeakRef(this));
  }
  return original.call(this, view(segment, whole), opts);
};

function patch(): void {
  if (!Component) return;
  // A reload imports this file again while the patch stays: hand out this import's bridge, and
  // install this import's wrapper, so drawing uses its view and not the previous import's.
  shared.bridge = bridge;
  shared.drain = drainClicks;
  const proto = Component.prototype;
  if (proto.updateContent === wrapper) return;
  shared.original ??= proto.updateContent;
  proto.updateContent = wrapper;
}

/** Restore omp's method and stop taking clicks; the next session start patches again. */
function unpatch(): void {
  if (shared.original && Component) Component.prototype.updateContent = shared.original;
  shared.original = undefined;
  shared.watcher?.close();
  shared.bridge = undefined;
  shared.watcher = undefined;
  shared.growing = undefined;
  shared.requestRender = undefined;
}

function redraw(timestamp: number): void {
  const entry = shown.get(timestamp);
  if (entry === undefined) return;
  entry.components = entry.components.filter(ref => ref.deref() !== undefined);
  if (entry.components.length === 0) {
    shown.delete(timestamp);
    return;
  }
  for (const ref of entry.components) {
    const component = ref.deref();
    const segment = component && segments.get(component);
    if (segment) component.updateContent(segment, { transient: false });
  }
  shared.requestRender?.();
}

type Found = { stretch: Stretch; index: number };

/** The block's stretches, ✦ answers spliced in, as its links number them. */
function allStretches(timestamp: number, blockIndex: number): Stretch[] {
  const block = shown.get(timestamp)?.message.content[blockIndex];
  if (block?.type !== "text") return [];
  return stretches(parse(spliced(`${timestamp}.${blockIndex}`, block.text)));
}

function stretchAt(timestamp: number, blockIndex: number, pick: (all: Stretch[]) => number): Found | undefined {
  const all = allStretches(timestamp, blockIndex);
  const index = pick(all);
  const stretch = all[index];
  return stretch === undefined ? undefined : { stretch, index };
}

function click(op: LinkOp, timestamp: number, blockIndex: number, index: number): void {
  const found = stretchAt(timestamp, blockIndex, () => index);
  if (found === undefined || !isLinkable(found.stretch)) return;
  if (op === "deepen") void deepen(timestamp, blockIndex, found);
  else setOpen(timestamp, blockIndex, found.stretch.key, op === "open", found);
}

/**
 * A ✦ press: ask the model, in a side turn over the whole conversation, for what comes next inside
 * one fully open stretch. While it waits the ✦ twinkles with a seconds count, the answer streams in
 * where it will land, and the finished answer stays there as a new open `✦` stretch.
 */
async function deepen(timestamp: number, blockIndex: number, found: Found): Promise<void> {
  const { stretch } = found;
  const id: BlockId = `${timestamp}.${blockIndex}`;
  const tag = `${id}\0${stretch.key}`;
  const signal = shared.presses?.signal;
  const open = (key: string) => openKeys.get(id)?.has(key) === true;
  if (!shared.ask || !signal || running.has(tag) || !isLinkable(stretch) || !canDeepen(stretch, open)) return;
  const press = { start: Date.now(), partial: "" };
  running.set(tag, press);
  // Redraw while the press runs: the twinkle and the seconds move even before any text arrives.
  const tick = () => {
    if (running.get(tag) !== press) return;
    try {
      redraw(timestamp);
    } catch {}
    setTimeout(tick, TWINKLE_MS).unref();
  };
  tick();
  try {
    const parents = allStretches(timestamp, blockIndex)
      .filter(s => stretch.key.startsWith(s.key + KEY_SEPARATOR))
      .map(s => s.short);
    const section = writeOpen(stretch.long);
    const reply = await shared.ask(deepenPrompt(section, parents), delta => {
      press.partial += delta;
    }, signal);
    // A switch or a /tree move aborted the press; a fork keeps it, and it lands in the forked session.
    if (signal.aborted) return;
    const block = shown.get(timestamp)?.message.content[blockIndex];
    const answer =
      block?.type === "text" ? spliceAnswer(block.text, answers.get(id) ?? [], stretch.key, reply) : undefined;
    if (answer === undefined) {
      shared.warn?.(`${DEEPEN} The answer came back empty, too long or with broken markup; press again to retry.`);
      return;
    }
    answers.set(id, [...(answers.get(id) ?? []), { key: stretch.key, text: answer.text }]);
    shared.deepened.push({ section, text: answer.text });
    shared.save?.({ block: id, section, key: stretch.key, text: answer.text });
    shared.wrote?.(answer.nested.filter(isLinkable).map(s => ({ id: `${id}\0${s.key}`, short: s.short })));
    // Open at once, without growing: the streamed text is already on screen.
    const open = openKeys.get(id) ?? new Set<string>();
    openKeys.set(id, open);
    open.add(answer.key);
    seen.add(`${id}\0${answer.key}`);
  } catch (error) {
    if (!signal.aborted) shared.warn?.(`${DEEPEN} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running.delete(tag);
    redraw(timestamp);
  }
}

/**
 * Open (growing it in place) or close a stretch; one of a reply not on screen only changes state.
 * `found` is the stretch when the caller already parsed its block.
 */
function setOpen(timestamp: number, blockIndex: number, key: string, isOpen: boolean, found?: Found): void {
  const id: BlockId = `${timestamp}.${blockIndex}`;
  const open = openKeys.get(id) ?? new Set<string>();
  openKeys.set(id, open);
  if (!isOpen) {
    // Closing a stretch closes everything nested in it.
    for (const k of [...open]) if (k === key || k.startsWith(key + KEY_SEPARATOR)) open.delete(k);
    if (shared.growing?.block === id) shared.growing = undefined;
    redraw(timestamp);
    return;
  }
  if (open.has(key)) return;
  open.add(key);
  seen.add(`${id}\0${key}`);
  const at = found ?? stretchAt(timestamp, blockIndex, all => all.findIndex(s => s.key === key));
  if (at === undefined) return;
  const duration = Math.min(700, 45 * lengthOf(at.stretch.long ?? []));
  const now: Growth = { timestamp, block: id, key, start: Date.now(), duration };
  const previous = shared.growing;
  shared.growing = now;
  // The growth this one replaces stops ticking: draw its reply at full length.
  if (previous !== undefined && previous.timestamp !== timestamp) redraw(previous.timestamp);
  const tick = () => {
    try {
      if (shared.growing !== now) return;
      if (Date.now() - now.start >= now.duration) shared.growing = undefined;
      else setTimeout(tick, FRAME_MS).unref();
      redraw(timestamp);
    } catch {
      shared.growing = undefined;
    }
  };
  tick();
}

const bridge: StretchBridge = {
  version: 1,
  state: () => {
    const presses: Record<BlockId, { key: string; seconds: number; partial: string }[]> = {};
    for (const [tag, press] of running) {
      const [block = "", key = ""] = tag.split("\0");
      // Whole seconds, so a press changes the reported state once a second, not every redraw.
      (presses[block] ??= []).push({ key, seconds: Math.floor((Date.now() - press.start) / 1000), partial: press.partial });
    }
    return {
      off: shared.mode === "off",
      open: Object.fromEntries([...openKeys].filter(([, keys]) => keys.size > 0).map(([id, keys]) => [id, [...keys]])),
      deepen: shared.ask !== undefined && CLICKABLE,
      answers: Object.fromEntries([...answers].filter(([, list]) => list.length > 0)),
      running: presses,
    };
  },
  setOpen: (block, key, open) => {
    const match = /^(\d+)\.(\d+)$/.exec(block);
    if (match && key !== "") setOpen(Number(match[1]), Number(match[2]), key, open);
  },
  deepen: (block, key) => {
    const match = /^(\d+)\.(\d+)$/.exec(block);
    if (!match || key === "") return;
    const [timestamp, blockIndex] = [Number(match[1]), Number(match[2])];
    const found = stretchAt(timestamp, blockIndex, all => all.findIndex(s => s.key === key));
    if (found !== undefined && isLinkable(found.stretch)) void deepen(timestamp, blockIndex, found);
  },
};

function drainClicks(): void {
  for (const name of readdirSync(CLICK_DIR)) {
    if (!name.endsWith(".click")) continue;
    const path = join(CLICK_DIR, name);
    let body: string;
    try {
      body = readFileSync(path, "utf8").trim();
      // Tern writes in place: an empty file is still being written and fires another event.
      if (body === "") continue;
      unlinkSync(path);
    } catch {
      continue;
    }
    const match = /^(open|close|deepen)\/(\d+)\/(\d+)\/(\d+)$/.exec(body);
    if (match) click(match[1] as LinkOp, Number(match[2]), Number(match[3]), Number(match[4]));
  }
}

function watchClicks(): void {
  if (shared.watcher) return;
  mkdirSync(CLICK_DIR, { recursive: true, mode: 0o700 });
  // A killed omp (closed pane) never runs its exit hook: drop directories of dead processes.
  const root = dirname(CLICK_DIR);
  for (const name of readdirSync(root)) {
    try {
      process.kill(Number(name), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(join(root, name), { recursive: true, force: true });
    }
  }
  // The callback runs outside handler isolation: a throw here would end the session.
  shared.watcher = watch(CLICK_DIR, () => {
    try {
      shared.drain?.();
    } catch {}
  });
  shared.watcher.unref();
  if (!shared.exitHook) {
    shared.exitHook = true;
    process.once("exit", () => rmSync(CLICK_DIR, { recursive: true, force: true }));
  }
}

/** The mode `/stretch` last chose, for every omp process: `{ "mode": "off" | "light" | "dense" }`. */
const MODE_FILE = join(homedir(), ".omp", "agent", "stretch.json");

function readSavedMode(): Mode | undefined {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(MODE_FILE, "utf8"));
  } catch {
    return undefined;
  }
  if (!saved || typeof saved !== "object" || !("mode" in saved)) return undefined;
  const mode = saved.mode;
  return mode === "off" || mode === "light" || mode === "dense" ? mode : undefined;
}

/** Written whole and renamed into place, so a process reading it never sees half a file. */
function saveMode(mode: Mode): void {
  const temp = `${MODE_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ mode })}\n`);
  renameSync(temp, MODE_FILE);
}

const MODE_CHOICES: { value: Mode; description: string }[] = [
  { value: "dense", description: "Default: only each paragraph's gist in view, stretches used heavily" },
  { value: "light", description: "A sentence or two per paragraph in view, stretches used sparingly" },
  { value: "off", description: "Plain replies, no stretches" },
];

/** What `/stretch status` reports: this process's mode, the saved one, and what actually draws and clicks. */
function statusText(): string {
  const saved = readSavedMode();
  const savedText =
    saved === undefined ? `nothing saved in ${MODE_FILE} (default dense)` : `${saved} (${MODE_FILE})`;
  const pending = saved !== undefined && saved !== modeOf() ? `; switches to ${saved} on the next message` : "";
  const drawing = Component?.prototype.updateContent === wrapper ? "patched" : "not patched (replies show as omp draws them)";
  const clicks = !CLICKABLE
    ? "off: not in Tern, stretches drawn open"
    : shared.watcher
      ? "on (Tern; needs the omp-stretch Tern plugin)"
      : "off: click watcher not running";
  return [
    `Stretchtext in this omp: ${modeOf()}${pending}`,
    `Saved for every session: ${savedText}`,
    `Reply drawing: ${drawing}`,
    `Clicks: ${clicks}`,
  ].join("\n");
}

export default function stretch(pi: ExtensionAPI): void {
  if (!Component) return;
  patch();
  /** Linkable stretches of the main session's replies since the last note. */
  let pending: { id: string; short: string }[] = [];
  shared.wrote = written => pending.push(...written);
  /** Set by `/stretch` when the mode changes, until the next prompt tells the model. */
  let switched: Mode | undefined;
  const isMainTui = (ctx: { mode: string; agent: { kind: string } }) =>
    CLICKABLE && ctx.mode === "tui" && ctx.agent.kind === "main";
  const active = (ctx: { mode: string; agent: { kind: string } }) => isMainTui(ctx) && shared.mode !== "off";
  // A process's first import starts from the saved mode; the model has no guide yet, so no note.
  shared.mode ??= readSavedMode();

  /** Switch this process to `next`: the next prompt tells the model, and `off` changes redraw replies. */
  const applyMode = (next: Mode) => {
    if (modeOf() === next) return;
    switched = next;
    const redrawAll = (modeOf() === "off") !== (next === "off");
    shared.mode = next;
    if (!redrawAll) return;
    pending = [];
    // Redraw replies on screen: links when on, fully open text when off.
    for (const timestamp of [...shown.keys()]) redraw(timestamp);
  };

  pi.registerCommand("stretch", {
    description: "Stretchtext replies for every omp session: /stretch dense | light | off | status",
    getArgumentCompletions: prefix => {
      const typed = prefix.trim().toLowerCase();
      const modes = MODE_CHOICES.filter(choice => choice.value.startsWith(typed)).map(choice => ({
        ...choice,
        label: choice.value === modeOf() ? `${choice.value} (current)` : choice.value,
      }));
      return "status".startsWith(typed)
        ? [...modes, { value: "status", label: "status", description: "Show this session's mode, the saved mode, and whether clicks work" }]
        : modes;
    },
    handler: (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "off" || arg === "light" || arg === "dense") {
        // Saved first: the next prompt syncs every process to the saved mode, this one included.
        try {
          saveMode(arg);
        } catch (error) {
          ctx.ui.notify(`Stretchtext stays ${modeOf()}: saving ${arg} failed: ${String(error)}`, "warning");
          return;
        }
        applyMode(arg);
      } else if (arg === "status") {
        ctx.ui.notify(statusText(), "info");
        return;
      } else if (arg !== "") {
        ctx.ui.notify("Usage: /stretch dense | light | off | status", "warning");
        return;
      }
      const where = CLICKABLE ? "" : " (outside Tern stretches are always drawn open and never requested)";
      ctx.ui.notify(`Stretchtext is ${modeOf()} for every omp session${where}.`, "info");
    },
  });

  /**
   * Follow the main session: its branch for `wholeReply`, its side turn and entries for ✦. Unless
   * `keepPresses` (a fork, whose transcript stays on screen), presses still running are abandoned.
   */
  const followSession = (ctx: ExtensionContext, keepPresses = false) => {
    shared.branch = () => ctx.sessionManager.getBranch();
    if (!keepPresses || !shared.presses) {
      shared.presses?.abort();
      shared.presses = new AbortController();
    }
    // Same model, system prompt, tools and history as the main turn, so the provider serves all of it
    // from the prompt cache; `tools: false` would change the prefix and miss it entirely. The output
    // cap bounds a press's cost, but only where it leaves the request as it is: on a budget-thinking
    // model a cap turns thinking off, which changes the cached request, and Codex or Cursor refuse a
    // cap before inference. `dedupeReply: false` hands over the reply whole; spliceAnswer judges it.
    shared.ask = ctx.runEphemeralTurn
      ? async (promptText, onDelta, signal) => {
          const thinking = ctx.model?.thinking?.mode;
          const budget = thinking === "budget" || thinking === "anthropic-budget-effort";
          const turn = { promptText, onTextDelta: onDelta, signal, dedupeReply: false };
          if (budget && String(pi.getThinkingLevel()) !== "off") return (await ctx.runEphemeralTurn!(turn)).replyText;
          try {
            return (await ctx.runEphemeralTurn!({ ...turn, maxTokens: DEEPEN_MAX_TOKENS })).replyText;
          } catch (error) {
            if (!String(error).includes("Omit the cap")) throw error;
            return (await ctx.runEphemeralTurn!(turn)).replyText;
          }
        }
      : undefined;
    shared.save = entry => pi.appendEntry(DEEPEN_TYPE, entry);
    shared.warn = message => ctx.ui.notify(message, "warning");
    // Answers live in the session file, so a resumed or reloaded session shows them again. Those
    // after the branch's last note that reported answers were never reported: the next note does.
    answers.clear();
    shared.deepened.length = 0;
    type Entry = { type?: string; customType?: string; content?: unknown; data?: unknown };
    for (const entry of ctx.sessionManager.getBranch() as Entry[]) {
      if (entry.type === "custom_message" && entry.customType === NOTE_TYPE) {
        if (typeof entry.content === "string" && entry.content.includes(DEEPEN_REPORTED)) shared.deepened.length = 0;
        continue;
      }
      if (entry.type !== "custom" || entry.customType !== DEEPEN_TYPE) continue;
      const data = entry.data as Partial<{ block: string; section: string; key: string; text: string }> | undefined;
      if (typeof data?.block !== "string" || typeof data.key !== "string" || typeof data.text !== "string") continue;
      answers.set(data.block, [...(answers.get(data.block) ?? []), { key: data.key, text: data.text }]);
      shared.deepened.push({ section: data.section ?? "", text: data.text });
    }
  };

  pi.on("session_start", (_event, ctx) => {
    patch();
    if (!isMainTui(ctx)) return;
    followSession(ctx);
    watchClicks();
    // Borrow the TUI handle from a throwaway widget: a click redraw happens outside any render cycle.
    ctx.ui.setWidget("omp-stretch", tui => {
      shared.requestRender = () => tui.requestRender();
      return { render: () => [] };
    });
    ctx.ui.setWidget("omp-stretch", undefined);
  });
  pi.on("session_switch", (event, ctx) => {
    patch();
    pending = [];
    if (isMainTui(ctx)) followSession(ctx, event.reason === "fork");
    // A fork keeps the transcript on screen, so its replies must stay clickable.
    if (event.reason === "fork") return;
    shown.clear();
    replies.clear();
  });
  // /tree moves to another branch of the same session: its answers and unreported notes differ.
  pi.on("session_tree", (_event, ctx) => {
    if (!isMainTui(ctx)) return;
    followSession(ctx);
    for (const timestamp of [...shown.keys()]) redraw(timestamp);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind === "main") unpatch();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !hasMarkup(event.message.content)) return;
    const message = event.message;
    replies.set(message.timestamp, message);
    // A segment drawn before the reply ended numbered its blocks on its own: number them in the reply.
    const entry = shown.get(message.timestamp);
    if (entry !== undefined && entry.message !== message) {
      entry.message = message;
      redraw(message.timestamp);
    }
    if (!active(ctx)) return;
    message.content.forEach((block, i) => {
      if (block.type !== "text" || !block.text.includes("{{")) return;
      for (const s of stretches(parse(block.text))) {
        if (isLinkable(s)) pending.push({ id: `${message.timestamp}.${i}\0${s.key}`, short: s.short });
      }
    });
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!isMainTui(ctx)) return;
    // Another omp process may have changed the saved mode since this one's last prompt.
    const saved = readSavedMode();
    if (saved !== undefined) applyMode(saved);
    const told = switched;
    switched = undefined;
    const mode = modeOf();
    const transition = promptTransition(event.systemPrompt, mode, told, pending, seen);
    const added = mode === "off" ? undefined : deepenNote(shared.deepened.splice(0));
    const content = [transition.content, added].filter(text => text !== undefined).join(" ") || undefined;
    if (mode !== "off") {
      pending = [];
      // The note just reported every opening that counts; later ones belong to replies still to come.
      seen.clear();
    }
    return {
      systemPrompt: transition.systemPrompt,
      message: content === undefined ? undefined : { customType: NOTE_TYPE, content, display: false },
    };
  });
}
