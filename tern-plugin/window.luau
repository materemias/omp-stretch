--!strict
-- Clicks on stretchtext links in omp replies (stretch.ts) never open a browser: each is dropped as a
-- file into the click directory of the omp process named in the URL, which grows or shrinks the
-- stretch in place. A link of a process that has exited is swallowed. When the clicked pane lives on a
-- remote host, the omp process's folder is on that machine: the plugin's host half there writes it.
--
-- URL: https://cc-stretch.invalid/<pid>/<open|close>/<timestamp>/<block>/<index>

local seq = 0

-- Stretch links read as quiet, muted blue text: no underline, so real links keep theirs and stand
-- apart; a dotted underline shows on hover. « after an open one gets none. Tern's CSS engine has no
-- dotted text-decoration, so the dots are a bottom border, transparent until hover so the row never
-- moves. Tern underlines reply links per layout (reader: an inset box-shadow; console:
-- text-decoration), so each layout's rule, hover included, is overridden by a selector at least as
-- specific.
--
-- The color is omp's `mdExtensionLink`: the theme's value where Tern exposes it, else omp's derived
-- default, 45% `mdLink` and 55% `text` mixed in sRGB, so a stretch has one color in Tern and in a
-- plain terminal. Tern's text fallback is the theme's terminal foreground, as in omp.
tern.css(
	"links",
	[[
.md a[href*="cc-stretch.invalid/"][href*="/open/"],
.sf-chat-console .sf-md .md a[href*="cc-stretch.invalid/"][href*="/open/"],
.sf-chat-reader [data-role^='omp.assistant'] > .sf-md .md a[href*="cc-stretch.invalid/"][href*="/open/"] {
	box-shadow: none;
	text-decoration: none;
	border-bottom: 1.5px dotted transparent;
	color: var(--omp-mdExtensionLink, color-mix(in srgb, var(--omp-mdLink, var(--accent-ink)) 45%, var(--omp-text, var(--tv-fg, var(--t1)))));
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

tern.route.link(function(link: LinkRequest, cx: WindowCx): RouteDecision?
	local pid, action = string.match(link.url, "^https://cc%-stretch%.invalid/(%d+)/(.+)$")
	if pid == nil or action == nil then
		return nil
	end
	-- The window's machine is not the omp process's when the clicked pane lives on a remote host; the
	-- host half's `click` block, opened there, writes the file instead (host.luau).
	if cx.hosts:current().kind == "remote" then
		return { block = "omp-stretch.click", args = { pid, action } }
	end
	-- Same folder as clickRoot in stretch-core.ts (which says why) and host.luau: keep all three in lockstep.
	local root = "/tmp/omp-stretch-" .. (tern.getenv("USER") or "")
	for _, name in { "XDG_RUNTIME_DIR", "LOCALAPPDATA" } do
		local value = tern.getenv(name)
		if value and value ~= "" then
			root = value .. "/omp-stretch"
			break
		end
	end
	local dir = root .. "/" .. pid
	if tern.fs.exists(dir) then
		seq += 1
		tern.fs.write(string.format("%s/%d-%d.click", dir, math.floor(tern.now() * 1000), seq), action)
	end
	return { handled = true }
end)

-- Update check, only for a copy installed with `tern plugin install` (a window-only machine): a
-- plugin linked from an omp install has stretch.ts beside its folder, and omp's `/stretch update`
-- relinks it. At most once a day, across windows, ask GitHub for the latest release, and toast a
-- newer one once per version.
local INSTALL = "tern plugin install github.com/materemias/omp-stretch/tern-plugin --force"
local DAY_S = 24 * 60 * 60

local function parseVersion(text: string): { number }?
	local a, b, c = string.match(text, "^v?(%d+)%.(%d+)%.(%d+)$")
	if a == nil then
		return nil
	end
	return { tonumber(a) :: number, tonumber(b) :: number, tonumber(c) :: number }
end

local function isNewer(a: string, b: string): boolean
	local x, y = parseVersion(a), parseVersion(b)
	if x == nil or y == nil then
		return false
	end
	for i = 1, 3 do
		if x[i] ~= y[i] then
			return x[i] > y[i]
		end
	end
	return false
end

local function checkForUpdate()
	local ok, manifest = pcall(tern.fs.read, tern.plugin.dir .. "/plugin.toml")
	local current = ok and string.match(manifest, '\nversion = "([^"]+)"') or nil
	if current == nil then
		return
	end
	local now = os.time()
	local checked = tern.kv.get("updateCheckedAt")
	if type(checked) == "number" and now - checked < DAY_S then
		return
	end
	tern.kv.set("updateCheckedAt", now)
	tern.fetch("https://api.github.com/repos/materemias/omp-stretch/releases/latest", {
		headers = { Accept = "application/vnd.github+json", ["User-Agent"] = "omp-stretch" },
		timeout_ms = 10000,
	}, function(result: FetchResult, cx: WindowCx?)
		if result.status ~= 200 or cx == nil then
			return
		end
		local decoded, body = pcall(tern.json.decode, result.body)
		local tag = decoded and type(body) == "table" and body.tag_name or nil
		if type(tag) ~= "string" then
			return
		end
		local latest = string.gsub(tag, "^v", "")
		if not isNewer(latest, current) or tern.kv.get("updateNotified") == latest then
			return
		end
		tern.kv.set("updateNotified", latest)
		cx:toast("info", `omp-stretch {latest} is out (you have {current})`, `Update: {INSTALL}`)
	end)
end

if not tern.fs.exists(tern.plugin.dir .. "/../stretch.ts") then
	-- Off the startup path, then daily for a window left open. Re-armed first, so a raising kv read
	-- does not end the chain.
	local function schedule(ms: number)
		tern.timer(ms, function()
			schedule(DAY_S * 1000)
			checkForUpdate()
		end)
	end
	schedule(10000)
end
