# Changelog

## Unreleased

## 0.7.0 (2026-11-21)

### Features

- `/stretch update` installs a newer release, which omp announces once.
- A Tern-only install toasts once when a newer release is out.

## 0.6.0 (2026-11-19)

### Features

- Other packages can import the parser as `omp-stretch/stretch-core`, as tern-awui does.

### Fixes

- A sentence the model wrapped in `{{…}}` with no short form opens from the words before it.

### Docs

- "Works well with" in the README covers tern-awui, omp-compact and CodexBar AgentView.

## 0.5.2 (2026-11-15)

### Features

- `/stretch status` shows the folder Tern clicks land in.

### Fixes

- On Windows, clicking a stretch in Tern works in omp sessions started on any drive ([#1](https://github.com/materemias/omp-stretch/issues/1)).

## 0.5.0 (2026-11-15)

### Features

- In Tern, stretch links use omp's muted extension-link color.

### Fixes

- In Tern, a markdown link with parentheses in its URL or a title grows whole.

## 0.4.1 (2026-11-12)

### Fixes

- In Tern, a markdown link in a stretch grows whole, and a file name stays in place as it grows into its path.

## 0.4.0 (2026-11-06)

### Features

- Stretches work in plain terminals on omp 18.17.0+ through omp's link hint key or mouse. Needs **Extension Reply Renderers** on.
- After a long reply without stretches, the next message reminds the model to use them. Code blocks don't count toward long.
- `/stretch section` shows the model a worked example with one stretch per section.

### Fixes

- A stretch whose short form is only punctuation opens from the words of its sentence.
- Pressing ✦ again adds a second answer instead of failing.
- A gist written before its stretch shows once even when it holds a `snake_case` word.
- A ✦ answer after a long form ending in a table starts its own paragraph, instead of being dropped as an extra table cell.

## 0.3.2 (2026-10-27)

### Fixes

- Stretches open from a Tern window remoted to omp's machine. Install the Tern plugin on both machines.

## 0.3.1 (2026-10-25)

### Fixes

- Opening a stretch whose long form rewrites its short form keeps the short form in view, with the long form after it.
- A stretch with an empty long form shows as plain text instead of a link that opens to nothing.

## 0.3.0 (2026-10-24)

### Features

- Experimental `/stretch section` mode folds each heading's section to one line.
- `advisor.md` teaches omp's advisor to read stretch markup instead of flagging it as duplicated text.

### Fixes

- A gist written both before its stretch and as its short form shows once.
- The guide tells the model to write each short form once and ends with an example reply.

## 0.2.0 (2026-10-22)

### Features

- ✦ on a fully open stretch asks the model for more on that section; the answer streams in place and can be deepened again.
- While a ✦ press waits, the star twinkles and counts seconds until the first words arrive.
- ✦ answers come back on resume, reload, session switch and `/tree`, and the next read note reports them.
- Stretches that end on the same word share one `«`.
- tern-awui can press ✦ and shows saved and running answers.

### Fixes

- An answer that is empty, longer than 2,000 characters or would break the reply's markup is refused with a toast.
- A session switch or `/tree` move stops a running ✦ press; a fork keeps it.
- A running press redraws once a second, so a click is less likely to land on a link being replaced.

### Docs

- README section "Ask for more" on ✦ and its cost; the demo GIF and MP4 show a ✦ press.

### Internal

- ✦ presses reuse the main turn's prompt cache and cap output at 1,500 tokens where the provider allows it.

## 0.1.0 (2026-10-21)

First release.

### Features

- The model writes `{{short|long}}` stretches; in Tern a short form grows its long form in place, and `«` closes it.
- Nested stretches open one level at a time.
- The next prompt carries a hidden note listing the stretches you opened and the ones you didn't.
- Streaming shows short forms only; aborted stretches and multi-line short forms are drawn open.
- Placeholders without a pipe, such as `{{name}}`, keep their braces.
- `/stretch dense | light | off | status` sets the mode for every omp process; `dense` is the default.
- Tern plugin `omp-stretch` routes stretch clicks to the omp process that drew them and styles stretch links.
- tern-awui shows and opens the same stretches on the phone through the version 1 bridge.
- Install with `omp plugin marketplace add materemias/omp-stretch` and `omp plugin install omp-stretch@omp-stretch`.

### Docs

- README points to [tern-awui](https://github.com/materemias/tern-awui).
- MIT license, including cc-stretch's copyright notice for the ported parser, growth logic and guide text.

### Internal

- Pushing a `vX.Y.Z` tag publishes a GitHub release with that version's changelog section, after the tests pass.

### Known limitations

- omp-stretch patches an omp internal, so an omp release can break it; it needs omp 18.11.0+ and turns off if that's gone.
- Clicks work only in Tern; elsewhere stretches are drawn open.
- Open stretches live in memory and close when omp restarts.
