// Stretchtext replies for omp, after pro-vi/cc-stretch (MIT): the model writes `{{short|long}}`, the
// chat shows each short form as a link, and picking it grows it in place. The session keeps the
// model's markup as written.
//
// In Tern, this patches AssistantMessageComponent.updateContent to rewrite the displayed text, and
// clicks reach omp through the `omp-stretch` Tern plugin (tern-plugin/), which claims links to
// cc-stretch.invalid and drops each as a file in this process's click directory. In a plain terminal
// an assistant text renderer draws `cc-stretch:` links that omp lets the reader pick by hint tag or
// click and hands to `link_activate`; the patch only covers omp's renderers being off. Where no pick
// can land, stretches are drawn open and the model is not asked to write them.
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
  isPlainReply,
  KEY_SEPARATOR,
  lengthOf,
  LINK_SCHEME,
  type LinkView,
  type Mode,
  type LinkOp,
  linkedMarkdown,
  parse,
  parseClick,
  promptTransition,
  type Segment,
  streamingView,
  type Stretch,
  stretches,
  withAnswers,
  writeOpen,
} from "./stretch-core.ts";

// An internal omp module, served to extensions only from omp 18.11.0. On an older or restructured
// omp, Tern gets nothing: no guide, so the model writes no stretches it cannot show. A plain terminal
// carries on through omp's extension API.
const Component: typeof AssistantMessageComponent | undefined = await import(
  "@oh-my-pi/pi-tui/chat/assistant-message"
).then(
  module =>
    typeof module.AssistantMessageComponent?.prototype?.updateContent === "function"
      ? module.AssistantMessageComponent
      : undefined,
  () => undefined,
);

// omp's key hints, to name the link hint key in the footer; internal, so it may be missing.
const linkHintKey: (() => string) | undefined = await import("@oh-my-pi/pi-tui/chrome/keybinding-hints").then(
  module => (typeof module.editorKey === "function" ? () => module.editorKey("app.links.hint") : undefined),
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
   * Outside Tern, the text of each block the text renderer drew, as written. Picks resolve against it,
   * since a block sealed at a tool call draws links before its reply is in `shown`, and its ids say
   * which replies a mode change redraws, with or without the patch.
   */
  renderedBlocks: Map<BlockId, string>;
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
  /** Whether omp lets the reader pick `cc-stretch:` links now; set by the main TUI session outside Tern. */
  linkClicks?: () => boolean;
  /** Draws a reply again through omp's text renderers (`ctx.ui.rerenderMessage`), outside Tern. */
  rerender?: (timestamp: number) => void;
  /** A reply is being drawn, outside Tern: what links it shows may have changed. */
  replyDrawn?: (timestamp: number) => void;
  /** Outside Tern: the footer's line on the ✦ presses running. */
  pressStatus?: (text: string | undefined) => void;
  /** While `redrawAll` runs: the replies drawn so far, by whichever redraw reached them. */
  drawnNow?: Set<number>;
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
  /** The main session's side turn, its entry writer and its toasts; unset outside the main TUI. */
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
state.renderedBlocks ??= new Map();
state.segments ??= new WeakMap();
state.replies ??= new Map();
state.sources ??= new WeakMap();
state.answers ??= new Map();
state.running ??= new Map();
state.deepened ??= [];
delete (state as { produced?: unknown }).produced;
const shared = state as Shared;
const { openKeys, seen, shown, renderedBlocks, segments, replies, sources, answers, running } = shared;
const modeOf = (): Mode => shared.mode ?? "dense";
/** Outside Tern: whether omp lets the reader pick the links the text renderer draws. */
const pickable = () => shared.linkClicks?.() === true;
/**
 * Set at load when this omp has extension text renderers and link schemes. Picks need 18.17.0: from
 * 18.15.0 omp loads an extension late from its second launch on, and its links stop reaching here.
 */
let linkApi = false;
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

/**
 * `isPlainReply` for a finished reply. A tool-call step, or a reply cut off by an abort, an error or
 * the token cap, says nothing about whether the model still writes stretches.
 */
function plainVerdict(message: Pick<AssistantMessage, "stopReason" | "content">): boolean | undefined {
  if (message.stopReason !== "stop") return undefined;
  return isPlainReply(message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n\n"));
}

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
    // Where omp routes the links' picks here, the text renderer draws the block as it streams and
    // after: a streaming draw rewritten here would reach the renderer's final call without markup.
    if (!CLICKABLE && pickable()) return block;
    if (whole === undefined) {
      const parts = parse(block.text);
      return stretches(parts).length === 0 ? block : { ...block, text: streamingView(parts) };
    }
    const found = whole.content.findIndex(b => b.type === "text" && b.text === block.text);
    const at = found === -1 ? i : found;
    const id: BlockId = `${segment.timestamp}.${at}`;
    const parts = parse(spliced(id, block.text));
    if (stretches(parts).length === 0) return block;
    if (shared.mode === "off" || !CLICKABLE) return { ...block, text: writeOpen(parts) };
    return { ...block, text: drawLinks(parts, id, (op, index) => `${HREF}${op}/${segment.timestamp}/${at}/${index}`) };
  });
  sources.set(content, segment.content);
  return { ...segment, content };
}

/** Block `id` as links: open stretches drawn open, one growing part-way, and ✦ presses as they run. */
function drawLinks(parts: Segment[], id: BlockId, href: LinkView["href"]): string {
  const open = openKeys.get(id);
  const now = shared.growing?.block === id ? shared.growing : undefined;
  return linkedMarkdown(parts, {
    href,
    isOpen: key => open?.has(key) === true,
    growing: now && { key: now.key, progress: Math.min(1, (Date.now() - now.start) / now.duration) },
    deepen: shared.ask && {
      progress: key => {
        const press = running.get(`${id}\0${key}`);
        return press && { elapsedMs: Date.now() - press.start, partial: press.partial };
      },
    },
  });
}

type TextRenderer = Parameters<ExtensionAPI["registerAssistantTextRenderer"]>[0];

/** A reply is being drawn: count it for `redrawAll`, and what links it shows may have changed. */
function noteDrawn(timestamp: number): void {
  shared.drawnNow?.add(timestamp);
  shared.replyDrawn?.(timestamp);
}

/**
 * The plain-terminal drawing, as omp's assistant text renderer: short forms while streaming, then
 * links of the scheme this extension claimed, or long forms with stretches off or where no pick can
 * land. Blocks the patch already drew open have no markup left to find.
 */
const renderText: TextRenderer = ({ message, contentIndex, text, streaming }) => {
  if (CLICKABLE) return undefined;
  noteDrawn(message.timestamp);
  if (!text.includes("{{")) return undefined;
  const id: BlockId = `${message.timestamp}.${contentIndex}`;
  const parts = parse(streaming ? text : spliced(id, text));
  if (stretches(parts).length === 0) return undefined;
  if (streaming) return streamingView(parts);
  renderedBlocks.set(id, text);
  if (shared.mode === "off" || !pickable()) return writeOpen(parts);
  return drawLinks(parts, id, (op, index) => `${LINK_SCHEME}:${op}/${message.timestamp}/${contentIndex}/${index}`);
};

type UpdateContent = AssistantMessageComponent["updateContent"];

/** This import's `updateContent`: draws through this import's `view`, then omp's own method. */
const wrapper: UpdateContent = function (this: AssistantMessageComponent, message, opts) {
  const original = shared.original!;
  // A component redrawing what it was given (omp's retry recovery spreads its last message) draws
  // from the source again, so the drawn links are never parsed as the reply.
  const source = sources.get(message.content);
  const segment = source === undefined ? message : { ...message, content: source };
  if (!hasMarkup(segment.content)) return original.call(this, segment, opts);
  noteDrawn(segment.timestamp);
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
  shared.linkClicks = undefined;
  shared.rerender = undefined;
  shared.replyDrawn = undefined;
  shared.pressStatus = undefined;
}

function redraw(timestamp: number): void {
  // omp redraws the reply wherever it is drawn: the viewport, the scrollback, or the link browser.
  if (!CLICKABLE) {
    shared.rerender?.(timestamp);
    return;
  }
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

/**
 * Redraw every reply on screen. In a plain terminal, redrawing one with rows in scrollback rebuilds
 * the whole scrollback, which draws the others: oldest first, and each is skipped once drawn.
 */
function redrawAll(): void {
  const drawn = new Set<number>();
  shared.drawnNow = drawn;
  // A block id starts with its reply's timestamp. Outside Tern the renderer records the replies it
  // drew with links; the patch, when present, also records those it drew open.
  const timestamps = new Set(shown.keys());
  if (!CLICKABLE) for (const id of renderedBlocks.keys()) timestamps.add(Number.parseInt(id, 10));
  try {
    for (const timestamp of [...timestamps]) {
      if (!drawn.has(timestamp)) redraw(timestamp);
    }
  } finally {
    shared.drawnNow = undefined;
  }
}

type Found = { stretch: Stretch; index: number };

/** The text of a block as written: as the text renderer last got it, else from the reply on screen. */
function blockText(timestamp: number, blockIndex: number): string | undefined {
  const drawn = renderedBlocks.get(`${timestamp}.${blockIndex}`);
  if (drawn !== undefined) return drawn;
  const block = shown.get(timestamp)?.message.content[blockIndex];
  return block?.type === "text" ? block.text : undefined;
}

/** The block's stretches, ✦ answers spliced in, as its links number them. */
function allStretches(timestamp: number, blockIndex: number): Stretch[] {
  const text = blockText(timestamp, blockIndex);
  return text === undefined ? [] : stretches(parse(spliced(`${timestamp}.${blockIndex}`, text)));
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

/** Outside Tern, tell the footer how long the oldest ✦ press has run, or that none is left. */
function showPresses(): void {
  const [oldest] = running.values();
  shared.pressStatus?.(oldest && `${DEEPEN} writing… ${Math.floor((Date.now() - oldest.start) / 1000)}s`);
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
  // While the press runs, the twinkle and the seconds move even before any text arrives. A plain
  // terminal counts in the footer instead: each redraw of a reply with rows in scrollback would
  // rebuild the scrollback, so the answer appears once, when it is done.
  const tick = () => {
    if (running.get(tag) !== press) return;
    try {
      if (CLICKABLE) redraw(timestamp);
      else showPresses();
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
    const text = blockText(timestamp, blockIndex);
    const answer = text === undefined ? undefined : spliceAnswer(text, answers.get(id) ?? [], stretch.key, reply);
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
    if (!CLICKABLE) showPresses();
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
  // A plain terminal redraws a reply with rows in scrollback by rebuilding the scrollback: no growth.
  if (!CLICKABLE) {
    redraw(timestamp);
    return;
  }
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
    const found = parseClick(body);
    if (found) click(found.op, found.timestamp, found.blockIndex, found.index);
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

/** The mode `/stretch` last chose, for every omp process: `{ "mode": "off" | "light" | "dense" | "section" }`. */
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
  return isMode(mode) ? mode : undefined;
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
  { value: "section", description: "Experimental: one line per section under a heading, dense inside" },
  { value: "off", description: "Plain replies, no stretches" },
];

const isMode = (value: unknown): value is Mode => MODE_CHOICES.some(choice => choice.value === value);

/** What `/stretch status` reports: this process's mode, the saved one, and what actually draws and clicks. */
function statusText(): string {
  const saved = readSavedMode();
  const savedText =
    saved === undefined ? `nothing saved in ${MODE_FILE} (default dense)` : `${saved} (${MODE_FILE})`;
  const pending = saved !== undefined && saved !== modeOf() ? `; switches to ${saved} on the next message` : "";
  const patched = Component?.prototype.updateContent === wrapper;
  const drawing =
    !CLICKABLE && linkApi
      ? `omp's text renderer${patched ? "" : "; not patched, so with Extension Reply Renderers off replies show as written"}`
      : patched
        ? "patched"
        : "not patched (replies show as omp draws them)";
  const clicks = CLICKABLE
    ? shared.watcher
      ? "on (Tern; needs the omp-stretch Tern plugin)"
      : "off: click watcher not running"
    : linkApi && pickable()
      ? "on: the link hint key (app.links.hint) tags each stretch to pick, or click one with tui.mouse on"
      : `off: ${PICK_HELP}; stretches drawn open`;
  return [
    `Stretchtext in this omp: ${modeOf()}${pending}`,
    `Saved for every session: ${savedText}`,
    `Reply drawing: ${drawing}`,
    `Clicks: ${clicks}`,
  ].join("\n");
}

/** Footer status keys in a plain terminal: how to open a stretch, and the ✦ presses running. */
const PICK_STATUS_KEY = "stretch";
const PRESS_STATUS_KEY = "stretch-press";

/** The footer's line on opening a stretch: the key as bound, or the mouse where it is unbound. */
function pickHint(): string {
  const key = linkHintKey?.();
  return key === "" ? "Click a stretch to open it" : `${key ?? "app.links.hint"}: open a stretch`;
}

/** What makes `cc-stretch:` links pickable in a plain terminal. */
const PICK_HELP =
  "needs omp 18.17.0 or newer with Tools → Extensions → Extension Reply Renderers (extensionRenderers.assistantText) on, and the link hint key (app.links.hint) bound or tui.mouse on";

export default function stretch(pi: ExtensionAPI): void {
  linkApi = typeof pi.registerAssistantTextRenderer === "function" && typeof pi.registerLinkScheme === "function";
  // Tern draws through the patch alone; a plain terminal carries on through omp's extension API.
  if (!Component && (CLICKABLE || !linkApi)) return;
  patch();
  // In Tern too, where it draws nothing: a text renderer keeps omp loading this file before the
  // first frame, so a resumed transcript goes through the patch instead of showing raw markup.
  if (linkApi) pi.registerAssistantTextRenderer(renderText);
  if (linkApi && !CLICKABLE) {
    pi.registerLinkScheme(LINK_SCHEME);
    // Redraws go through the main session's UI, which is also the one a focused subagent's pick gets.
    pi.on("link_activate", ({ url, scheme }) => {
      const found = parseClick(url.slice(scheme.length + 1));
      if (found) click(found.op, found.timestamp, found.blockIndex, found.index);
    });
  }
  /** Linkable stretches of the main session's replies since the last note. */
  let pending: { id: string; short: string }[] = [];
  shared.wrote = written => pending.push(...written);
  /** The mode the last prompt asked the model for; unset before this import's first prompt. */
  let prompted: Mode | undefined;
  /** The main session's last long reply had no stretches: the next prompt reminds the model once. */
  let lastPlain = false;
  const isMainTui = (ctx: { mode: string; agent: { kind: string } }) => ctx.mode === "tui" && ctx.agent.kind === "main";
  /** Whether the reader can open a stretch: through the Tern plugin, or by picking the links omp routes here. */
  const pickableIn = (ctx: ExtensionContext) => CLICKABLE || ctx.ui.getLinkClicksAvailable?.() === true;
  const active = (ctx: ExtensionContext) => isMainTui(ctx) && pickableIn(ctx) && shared.mode !== "off";
  /** The last reply the footer hint was decided for, and the hint shown. */
  let hintReply: AssistantMessage | undefined;
  let hintShown: string | undefined;
  /**
   * In a plain terminal, show in the footer how to open a stretch while the last reply, `message`,
   * has one to open; Tern readers click instead.
   */
  const syncPickHint = (ctx: ExtensionContext, message: AssistantMessage | undefined) => {
    if (CLICKABLE || !isMainTui(ctx)) return;
    hintReply = message;
    const openable =
      message !== undefined &&
      active(ctx) &&
      message.content.some(
        block => block.type === "text" && block.text.includes("{{") && stretches(parse(block.text)).some(isLinkable),
      );
    const hint = openable ? pickHint() : undefined;
    if (hint === hintShown) return;
    hintShown = hint;
    ctx.ui.setStatus?.(PICK_STATUS_KEY, hint);
  };
  // A process's first import starts from the saved mode; the model has no guide yet, so no note.
  shared.mode ??= readSavedMode();

  /** Switch this process to `next`: the next prompt tells the model, and `off` changes redraw replies. */
  const applyMode = (next: Mode) => {
    if (modeOf() === next) return;
    const linksChange = (modeOf() === "off") !== (next === "off");
    shared.mode = next;
    if (!linksChange) return;
    pending = [];
    // Redraw replies on screen: links when on, fully open text when off.
    redrawAll();
  };

  pi.registerCommand("stretch", {
    description: "Stretchtext replies for every omp session: /stretch dense | light | section | off | status",
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
      if (isMode(arg)) {
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
        ctx.ui.notify("Usage: /stretch dense | light | section | off | status", "warning");
        return;
      }
      const where = pickableIn(ctx) ? "" : " (here stretches are drawn open and never requested: see /stretch status)";
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
    lastPlain = false;
    let lastReply: AssistantMessage | undefined;
    type Entry = { type?: string; customType?: string; content?: unknown; data?: unknown; message?: { role?: string; content?: unknown } };
    for (const entry of ctx.sessionManager.getBranch() as Entry[]) {
      if (entry.type === "message") {
        // As live: a prompt carries any reminder, and the replies after it decide the next one.
        if (entry.message?.role === "user") lastPlain = false;
        if (entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
          lastPlain = plainVerdict(entry.message as AssistantMessage) ?? lastPlain;
          lastReply = entry.message as AssistantMessage;
        }
        continue;
      }
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
    syncPickHint(ctx, lastReply);
  };

  pi.on("session_start", (_event, ctx) => {
    patch();
    if (!isMainTui(ctx)) return;
    followSession(ctx);
    if (!CLICKABLE) {
      shared.linkClicks = () => ctx.ui.getLinkClicksAvailable?.() === true;
      shared.rerender = timestamp => ctx.ui.rerenderMessage?.(timestamp);
      shared.pressStatus = text => ctx.ui.setStatus?.(PRESS_STATUS_KEY, text);
      // Links appear and vanish without a new reply: a loaded session's become pickable only after
      // it loads, and `/stretch off` or a change of omp's settings redraws them open.
      shared.replyDrawn = timestamp => {
        if (hintReply?.timestamp === timestamp) syncPickHint(ctx, hintReply);
      };
      return;
    }
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
    renderedBlocks.clear();
    replies.clear();
  });
  // /tree moves to another branch of the same session: its answers and unreported notes differ.
  pi.on("session_tree", (_event, ctx) => {
    if (!isMainTui(ctx)) return;
    followSession(ctx);
    redrawAll();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind === "main") unpatch();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (isMainTui(ctx)) lastPlain = plainVerdict(event.message) ?? lastPlain;
    syncPickHint(ctx, event.message);
    if (!hasMarkup(event.message.content)) return;
    const message = event.message;
    replies.set(message.timestamp, message);
    // A segment drawn before the reply ended numbered its blocks on its own: number them in the reply.
    const entry = shown.get(message.timestamp);
    if (entry !== undefined && entry.message !== message) {
      entry.message = message;
      // omp's text renderer gets each block's index in the whole reply, so only the patch's links change.
      if (CLICKABLE) redraw(message.timestamp);
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
    // Where no pick can land, the model writes no stretches: they could only show open.
    const mode = pickableIn(ctx) ? modeOf() : "off";
    // A mode the model was not prompted with last time: the switch note tells it.
    const told = prompted !== undefined && prompted !== mode ? mode : undefined;
    prompted = mode;
    const transition = promptTransition(event.systemPrompt, mode, told, pending, seen, lastPlain);
    const added = mode === "off" ? undefined : deepenNote(shared.deepened.splice(0));
    const content = [transition.content, added].filter(text => text !== undefined).join(" ") || undefined;
    if (mode !== "off") {
      lastPlain = false;
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
