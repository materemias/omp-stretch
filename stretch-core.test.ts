import { describe, expect, test } from "bun:test";
import { guideFor, linkedMarkdown, type LinkView, parse, promptTransition, readNote, streamingView, stretches, writeOpen } from "./stretch-core.ts";

const closed: LinkView = { href: (op, index) => `u/${op}/${index}`, isOpen: () => false };

describe("parse", () => {
  test("full shows long forms, nested keys carry the parent", () => {
    const parts = parse("A {{cache|stale {{cache key|cache key from `package.json`}} cache}} here.");
    expect(writeOpen(parts)).toBe("A stale cache key from `package.json` cache here.");
    expect(stretches(parts).map(s => s.key)).toEqual(["cache", "cache › cache key"]);
  });

  test("braces inside code never open a stretch", () => {
    const text = "Use `{{a|b}}` and\n```\n{{x|y}}\n```\n";
    expect(stretches(parse(text))).toHaveLength(0);
  });

  test("a backtick without its closing run is text, so stretches after it still open", () => {
    const open = (text: string) => stretches(parse(text)).filter(s => s.isClosed).length;
    expect(open("Press the ` key. {{Cache fails.|The cache fails often.}}")).toBe(1);
    expect(open("``a ``` b`` {{short|long}}")).toBe(1);
  });

  test("a long form may close on its code fence's closing line", () => {
    const parts = parse("{{Run.|Run:\n```sh\nmake\n```}} after");
    expect(stretches(parts)[0]?.isClosed).toBe(true);
    // `after` starts its own line: on the fence line it would keep the code block open.
    expect(writeOpen(parts)).toBe("Run:\n```sh\nmake\n```\n after");
  });

  test("keys stay unique: a written `a~2` and a separator inside a short form", () => {
    expect(stretches(parse("{{a|a 1}} {{a|a 2}} {{a~2|a~2 3}}")).map(s => s.key)).toEqual(["a", "a~2", "a~2~2"]);
    expect(stretches(parse("{{a › b|x}} {{a|{{b|y}}}}")).map(s => s.key)).toEqual(["a > b", "a", "a › b"]);
  });

  test("final renderers preserve no-pipe placeholders, including unfinished ones", () => {
    for (const text of ["{{name}}", "{{}}", "{{name"]) {
      expect(writeOpen(parse(text))).toBe(text);
      expect(linkedMarkdown(parse(text), closed)).toBe(text);
    }
  });

  test("fully open fallback expands valid stretches and preserves nested placeholders", () => {
    expect(writeOpen(parse("A {{short|long {{name}} and {{nested|nested detail}}}}.")))
      .toBe("A long {{name}} and nested detail.");
  });
});

describe("streamingView", () => {
  test("hides long forms, including one still being written", () => {
    expect(streamingView(parse("A {{b|b long}} c {{d|d half"))).toBe("A b c d");
  });

  test("preserves completed placeholders but hides incomplete markup", () => {
    expect(streamingView(parse("A {{name}} {{}} {{short"))).toBe("A {{name}} {{}} short");
    expect(streamingView(parse("A {{"))).toBe("A ");
  });
});

describe("linkedMarkdown", () => {
  test("a closed stretch is a link on its short form, brackets escaped", () => {
    expect(linkedMarkdown(parse("See {{the [docs](x)|the long docs}}."), closed)).toBe(
      "See [the docs (x)](u/open/0).",
    );
  });

  test("an open stretch shows its long form and a close link; nested ones stay closed", () => {
    const parts = parse("{{a|x a {{b|b y}} z}}.");
    const view: LinkView = { ...closed, isOpen: key => key === "a" };
    expect(linkedMarkdown(parts, view)).toBe("x a [b](u/open/1) z [«](u/close/0).");
  });

  test("a stretch the reader cannot open is drawn open, so an aborted reply hides nothing", () => {
    expect(linkedMarkdown(parse("Start {{short|long text cut off"), closed)).toBe("Start long text cut off");
    expect(linkedMarkdown(parse("{{two\nlines|whole paragraph}}"), closed)).toBe("whole paragraph");
  });

  test("a growing stretch starts at its short form's words and ends at its long form", () => {
    const parts = parse("{{fails on cache.|The CI build fails often on a stale cache.}}");
    const at = (progress: number) => linkedMarkdown(parts, { ...closed, isOpen: () => true, growing: { index: 0, progress } });
    expect(at(0)).toBe("fails on cache. [«](u/close/0)");
    expect(at(1)).toBe("The CI build fails often on a stale cache. [«](u/close/0)");
  });
});

describe("linkedMarkdown structure", () => {
  test("paragraphs and list items keep their own links, and an open long form keeps its list", () => {
    const parts = parse("{{A|A:\n\n- one\n- two}}\n\n- {{x|x long}}\n- y");
    expect(linkedMarkdown(parts, closed)).toBe("[A](u/open/0)\n\n- [x](u/open/1)\n- y");
    expect(linkedMarkdown(parts, { ...closed, isOpen: key => key === "A" })).toBe(
      "A:\n\n- one\n- two [«](u/close/0)\n\n- [x](u/open/1)\n- y",
    );
  });

  test("a long form ending in a code block keeps its closing fence; « gets its own paragraph", () => {
    const parts = parse("{{Run it.|Run it:\n\n```sh\nmake\n```\n}}\n\nThen read the log.");
    expect(linkedMarkdown(parts, { ...closed, isOpen: () => true })).toBe(
      "Run it:\n\n```sh\nmake\n```\n\n[«](u/close/0)\n\n\nThen read the log.",
    );
  });
});

describe("readNote", () => {
  const written = [
    { id: "1", short: "cache" },
    { id: "2", short: "key " },
  ];

  test("names opened and unopened stretches", () => {
    expect(readNote(written, new Set(["1"]))).toBe(
      'Stretchtext: since your last reply the reader opened "cache"; they did not open "key"',
    );
  });

  test("says when nothing was opened, and stays silent without stretches", () => {
    expect(readNote(written, new Set())).toContain("opened no stretch");
    expect(readNote([], new Set())).toBeUndefined();
  });
});

describe("promptTransition", () => {
  const written = [{ id: "1", short: "cache" }];
  const opened = new Set(["1"]);

  test("swaps dense and light guides and announces the new level", () => {
    for (const [before, after] of [["dense", "light"], ["light", "dense"]] as const) {
      const result = promptTransition(["base", guideFor(before)], after, after, [], opened);
      expect(result.systemPrompt).toEqual(["base", guideFor(after)]);
      expect(result.content).toStartWith(`Stretchtext is now ${after}:`);
    }
  });

  test("off removes every guide and announces only an explicit switch", () => {
    const prompt = ["base", guideFor("dense"), guideFor("light")];
    const result = promptTransition(prompt, "off", "off", written, opened);
    expect(result.systemPrompt).toEqual(["base"]);
    expect(result.content).toBe("Stretchtext is now off: write plain replies, without {{short|long}} markup.");
    expect(promptTransition(prompt, "off", undefined, written, opened).content).toBeUndefined();
    expect(promptTransition(["base"], "off", undefined, written, opened).systemPrompt).toBeUndefined();
  });

  test("leaves one matching guide unchanged while still sending the read note", () => {
    const prompt = ["base", guideFor("dense")];
    const result = promptTransition(prompt, "dense", undefined, written, opened);
    expect(result.systemPrompt).toBeUndefined();
    expect(result.content).toBe(readNote(written, opened));
    expect(prompt).toEqual(["base", guideFor("dense")]);
    expect(promptTransition(prompt, "dense", undefined, [], opened).content).toBeUndefined();
  });

  test("combines a mode switch with the read note and removes duplicate guides", () => {
    const result = promptTransition(
      ["base", guideFor("light"), guideFor("light")], "light", "light", written, opened,
    );
    expect(result.systemPrompt).toEqual(["base", guideFor("light")]);
    expect(result.content).toBe(
      `Stretchtext is now light: at its shortest, a sentence or two per paragraph or list item. ${readNote(written, opened)}`,
    );
  });
});
