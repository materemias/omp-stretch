import { describe, expect, test } from "bun:test";
import { guideFor, linkedMarkdown, type LinkView, parse, promptTransition, readNote, spliceAnswer, streamingView, stretches, withAnswers, writeOpen } from "./stretch-core.ts";

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
    expect(writeOpen(parse("A {{short|short long {{name}} and {{nested|nested detail}}}}.")))
      .toBe("A short long {{name}} and nested detail.");
  });

  test("a gist written before its own stretch as well shows once", () => {
    expect(linkedMarkdown(parse("- **AMD is out.** {{AMD is out.|AMD is out: its data starts in 2021.}}"), closed)).toBe(
      "- [AMD is out.](u/open/0)",
    );
    expect(writeOpen(parse("Checks pass. Checks pass. {{Checks pass.|Checks pass, all 9.}}"))).toBe(
      "Checks pass. Checks pass, all 9.",
    );
    // Mid-sentence words that happen to match the short form stay.
    expect(linkedMarkdown(parse("on a stale cache {{cache|cache keyed by hash}}"), closed)).toBe(
      "on a stale cache [cache](u/open/0)",
    );
    // The line started before an earlier stretch, so " cache " is mid-sentence too.
    expect(linkedMarkdown(parse("{{Use|Use it}} cache {{cache|cache keyed by hash}}"), closed)).toBe(
      "[Use](u/open/0) cache [cache](u/open/1)",
    );
    // Code is never cut.
    expect(linkedMarkdown(parse("`let x = 1; x` {{x|x is returned}}"), closed)).toBe("`let x = 1; x` [x](u/open/0)");
    // Bold that opens before the copy and closes after the stretch keeps both marks.
    expect(writeOpen(parse("**Checks pass. {{Checks pass.|Checks pass in CI.}}**"))).toBe(
      "**Checks pass. Checks pass in CI.**",
    );
  });

  test("a long form that rewrites its short form keeps it in front, so both ideas show open", () => {
    const text = "- Rule: {{I added it to CLAUDE.md.|It covers commit types and changelog headings.}}";
    expect(writeOpen(parse(text))).toBe("- Rule: I added it to CLAUDE.md. It covers commit types and changelog headings.");
    expect(linkedMarkdown(parse(text), closed)).toBe("- Rule: [I added it to CLAUDE.md.](u/open/0)");
    // Most words kept, reworded or reordered: nothing is added.
    expect(writeOpen(parse("{{The build fails on a stale cache.|The CI build breaks on a stale dependency cache.}}")))
      .toBe("The CI build breaks on a stale dependency cache.");
    // A long form opening a list goes below the short form.
    expect(writeOpen(parse("{{Three steps.|- a\n- b}}"))).toBe("Three steps.\n\n- a\n- b");
  });

  test("a stretch with an empty long form is plain text and frees its key", () => {
    const parts = parse("- Current: {{every change gets an entry.|}} {{a| }} and {{a|a b}}");
    expect(linkedMarkdown(parts, closed)).toBe("- Current: every change gets an entry. a and [a](u/open/0)");
    expect(stretches(parts).map(s => s.key)).toEqual(["a"]);
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
    const at = (progress: number) => linkedMarkdown(parts, { ...closed, isOpen: () => true, growing: { key: "fails on cache.", progress } });
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

  test("swaps guides between levels and announces the new level", () => {
    const pairs = [["dense", "light"], ["light", "dense"], ["dense", "section"], ["section", "light"]] as const;
    for (const [before, after] of pairs) {
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

describe("deepen", () => {
  const allOpen: LinkView = { href: (op, index) => `u/${op}/${index}`, isOpen: () => true, deepen: { progress: () => undefined } };
  const pressed = (elapsedMs: number, partial: string): LinkView => ({
    ...allOpen,
    deepen: { progress: key => (key === "a" ? { elapsedMs, partial } : undefined) },
  });

  test("a fully open stretch gets ✦ before its «, once everything inside it is open too", () => {
    const parts = parse("{{a|a {{b|b x}} y}}");
    expect(linkedMarkdown(parts, allOpen)).toBe("a b x [✦](u/deepen/1) [«](u/close/1) y [✦](u/deepen/0) [«](u/close/0)");
    const bClosed = { ...allOpen, isOpen: (key: string) => key === "a" };
    expect(linkedMarkdown(parts, bClosed)).toBe("a [b](u/open/1) y [«](u/close/0)");
  });

  test("stretches ending on the same word share the innermost «", () => {
    const parts = parse("{{a|a {{b|b {{c|c x}}}}}} and {{d|d y}}");
    expect(linkedMarkdown(parts, allOpen)).toBe("a b c x [✦](u/deepen/2) [«](u/close/2) and d y [✦](u/deepen/3) [«](u/close/3)");
    // With c closed, b ends on c's link, not on a «: b gets its own, and a shares it.
    const cClosed = { ...allOpen, isOpen: (key: string) => key !== "a › b › c" };
    expect(linkedMarkdown(parts, cClosed)).toBe("a b [c](u/open/2) [«](u/close/1) and d y [✦](u/deepen/3) [«](u/close/3)");
  });

  test("a running press twinkles with its seconds until words arrive, then streams them in place", () => {
    const parts = parse("{{a|a long}}");
    expect(linkedMarkdown(parts, pressed(0, ""))).toBe("a long ✧ 0s [«](u/close/0)");
    expect(linkedMarkdown(parts, pressed(3_400, ""))).toBe("a long ✷ 3s [«](u/close/0)");
    // Stretches show only their short forms while streaming, as in a streaming reply: no half-written long form.
    expect(linkedMarkdown(parts, pressed(5_000, "✦ More {{b|b detail}} and {{c|c "))).toBe(
      "a long ✦ More b and c ✷ [«](u/close/0)",
    );
  });

  test("an answer goes in last inside its stretch, so earlier keys stay, and answers to answers nest", () => {
    const text = "{{a|a {{b|b x}} y}} and {{c|c z}}";
    const once = withAnswers(text, [{ key: "a › b", text: "more" }]);
    expect(once).toBe("{{a|a {{b|b x {{✦|✦ more}}}} y}} and {{c|c z}}");
    const twice = withAnswers(text, [{ key: "a › b › ✦", text: "deeper" }, { key: "a › b", text: "more" }]);
    expect(stretches(parse(twice)).map(s => s.key)).toEqual(["a", "a › b", "a › b › ✦", "a › b › ✦ › ✦", "c"]);
    expect(writeOpen(parse(twice))).toBe("a b x ✦ more ✦ deeper y and c z");
  });

  test("an answer after a long form ending in a code fence starts its own paragraph", () => {
    const text = withAnswers("{{Run.|Run:\n```sh\nmake\n```}} after", [{ key: "Run.", text: "more" }]);
    expect(writeOpen(parse(text))).toBe("Run:\n```sh\nmake\n```\n\n✦ more after");
  });

  test("an answer that would not stay inside its own stretch is refused", () => {
    const block = "{{p|p long}} tail `later` {{q|q z}}";
    const ok = spliceAnswer(block, [], "p", "  ✦ More {{x|x y}}.  ");
    expect(ok && { text: ok.text, key: ok.key, nested: ok.nested.map(s => s.key) }).toEqual({
      text: "More {{x|x y}}.",
      key: "p › ✦",
      nested: ["p › ✦ › x"],
    });
    // A stray }}, an unclosed fence, a lone backtick pairing with the later code span, broken or empty.
    for (const reply of ["see a}} b", "x\n```sh\nmake", "a ` b", "More {{x|x y", "   "]) {
      expect(spliceAnswer(block, [], "p", reply)).toBeUndefined();
    }
  });

  test("✦ waits until its stretch has grown open", () => {
    const view = { ...allOpen, growing: { key: "a", progress: 0.5 } };
    expect(linkedMarkdown(parse("{{a|a long}}"), view)).not.toContain("deepen");
  });
});
