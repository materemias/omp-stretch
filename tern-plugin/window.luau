--!strict
-- Clicks on stretchtext links in omp replies (stretch.ts) never open a browser: each is dropped as a
-- file into the click directory of the omp process named in the URL, which grows or shrinks the
-- stretch in place. A link of a process that has exited is swallowed.
--
-- URL: https://cc-stretch.invalid/<pid>/<open|close>/<timestamp>/<block>/<index>

local seq = 0

-- Stretch links read as quiet blue text: no underline, so real links keep theirs and stand apart; a
-- dotted underline shows on hover. « after an open one gets none. Tern's CSS engine has no dotted
-- text-decoration, so the dots are a bottom border, transparent until hover so the row never moves.
-- Tern underlines reply links per layout (reader: an inset box-shadow; console: text-decoration),
-- so each layout's rule, hover included, is overridden by a selector at least as specific.
tern.css(
	"links",
	[[
.md a[href*="cc-stretch.invalid/"][href*="/open/"],
.sf-chat-console .sf-md .md a[href*="cc-stretch.invalid/"][href*="/open/"],
.sf-chat-reader [data-role^='omp.assistant'] > .sf-md .md a[href*="cc-stretch.invalid/"][href*="/open/"] {
	box-shadow: none;
	text-decoration: none;
	border-bottom: 1.5px dotted transparent;
}
.md a[href*="cc-stretch.invalid/"][href*="/open/"]:hover,
.sf-chat-console .sf-md .md a[href*="cc-stretch.invalid/"][href*="/open/"]:hover,
.sf-chat-reader [data-role^='omp.assistant'] > .sf-md .md a[href*="cc-stretch.invalid/"][href*="/open/"]:hover {
	box-shadow: none;
	text-decoration: none;
	border-bottom: 1.5px dotted rgb(from var(--accent) r g b/70%);
}
.md a[href*="cc-stretch.invalid/"][href*="/close/"],
.sf-chat-console .sf-md .md a[href*="cc-stretch.invalid/"][href*="/close/"],
.sf-chat-reader [data-role^='omp.assistant'] > .sf-md .md a[href*="cc-stretch.invalid/"][href*="/close/"],
.md a[href*="cc-stretch.invalid/"][href*="/close/"]:hover,
.sf-chat-console .sf-md .md a[href*="cc-stretch.invalid/"][href*="/close/"]:hover,
.sf-chat-reader [data-role^='omp.assistant'] > .sf-md .md a[href*="cc-stretch.invalid/"][href*="/close/"]:hover {
	box-shadow: none;
	text-decoration: none;
	opacity: 0.75;
}
.md a[href*="cc-stretch.invalid/"][href*="/deepen/"],
.sf-chat-console .sf-md .md a[href*="cc-stretch.invalid/"][href*="/deepen/"],
.sf-chat-reader [data-role^='omp.assistant'] > .sf-md .md a[href*="cc-stretch.invalid/"][href*="/deepen/"],
.md a[href*="cc-stretch.invalid/"][href*="/deepen/"]:hover,
.sf-chat-console .sf-md .md a[href*="cc-stretch.invalid/"][href*="/deepen/"]:hover,
.sf-chat-reader [data-role^='omp.assistant'] > .sf-md .md a[href*="cc-stretch.invalid/"][href*="/deepen/"]:hover {
	box-shadow: none;
	text-decoration: none;
	font-weight: bold;
}
]]
)

tern.route.link(function(link: LinkRequest, _cx: WindowCx): RouteDecision?
	local pid, action = string.match(link.url, "^https://cc%-stretch%.invalid/(%d+)/(.+)$")
	if pid == nil or action == nil then
		return nil
	end
	-- Same folder as stretch.ts: $XDG_RUNTIME_DIR/omp-stretch, else one per user in /tmp.
	local runtime = tern.getenv("XDG_RUNTIME_DIR")
	local root = if runtime and runtime ~= "" then runtime .. "/omp-stretch" else "/tmp/omp-stretch-" .. (tern.getenv("USER") or "")
	local dir = root .. "/" .. pid
	if tern.fs.exists(dir) then
		seq += 1
		tern.fs.write(string.format("%s/%d-%d.click", dir, math.floor(tern.now() * 1000), seq), action)
	end
	return { handled = true }
end)
