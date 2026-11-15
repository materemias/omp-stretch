--!strict
-- The daemon half: block `click` drops one stretch click into the click directory of an omp process on
-- this machine, then ends. window.luau opens it on the clicked pane's host when that host is remote,
-- since only the daemon there can reach the omp process's runtime folder.
--
-- Args: <pid>, <action> (the URL path after the pid; see window.luau).

local seq = 0

tern.block.define("click", {
	init = function(cx: BlockCx, args: { string }, _saved: any)
		local pid, action = args[1], args[2]
		if pid and action and string.match(pid, "^%d+$") then
			-- Same folder as clickRoot in stretch-core.ts (which says why) and window.luau: keep all three in lockstep.
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
		end
		cx:exit(0)
		return {}
	end,
	view = function(_state: any, _cx: BlockCx): BlockView
		return { main = tern.ui.col({}) }
	end,
})
