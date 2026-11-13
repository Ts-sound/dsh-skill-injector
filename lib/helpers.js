
//#region src/helpers.ts
const MAX_SELECTED = 16;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODES = ["each-prompt", "start-only"];
function isSkillName(value) {
	return SKILL_NAME.test(value);
}
function validateSelection(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {
		ok: false,
		error: "settings must be an object { mode, selected }"
	};
	const raw = value;
	const mode = raw.mode;
	if (mode !== "each-prompt" && mode !== "start-only") return {
		ok: false,
		error: "mode must be \"each-prompt\" or \"start-only\""
	};
	if (!Array.isArray(raw.selected)) return {
		ok: false,
		error: "selected must be an array of skill names"
	};
	if (raw.showDock !== undefined && typeof raw.showDock !== "boolean") return {
		ok: false,
		error: "showDock must be a boolean"
	};
	const selected = [];
	for (const name of raw.selected) {
		if (typeof name !== "string" || !isSkillName(name)) return {
			ok: false,
			error: `invalid skill name "${String(name)}" (kebab-case required)`
		};
		if (!selected.includes(name)) selected.push(name);
	}
	if (selected.length > MAX_SELECTED) return {
		ok: false,
		error: `too many skills (max ${MAX_SELECTED})`
	};
	let workspaces;
	if (raw.workspaces !== undefined) {
		if (typeof raw.workspaces !== "object" || raw.workspaces === null || Array.isArray(raw.workspaces)) return {
			ok: false,
			error: "workspaces must be an object keyed by workspace id"
		};
		workspaces = {};
		for (const [id, list] of Object.entries(raw.workspaces)) {
			if (typeof id !== "string" || id.trim() === "") return {
				ok: false,
				error: "workspace ids must be non-empty strings"
			};
			if (!Array.isArray(list)) return {
				ok: false,
				error: `workspace "${id}" must map to an array of skill names`
			};
			const names = [];
			for (const name of list) {
				if (typeof name !== "string" || !isSkillName(name)) return {
					ok: false,
					error: `invalid skill name "${String(name)}" in workspace "${id}"`
				};
				if (!names.includes(name)) names.push(name);
			}
			if (names.length > MAX_SELECTED) return {
				ok: false,
				error: `too many skills in workspace "${id}" (max ${MAX_SELECTED})`
			};
			workspaces[id] = names;
		}
	}
	return {
		ok: true,
		config: {
			mode,
			selected,
			showDock: raw.showDock !== false,
			...workspaces !== undefined ? { workspaces } : {}
		}
	};
}
function mergeSelection(global, extra = [], max = MAX_SELECTED) {
	const merged = [];
	for (const name of [...global, ...extra]) if (!merged.includes(name)) merged.push(name);
	return {
		selected: merged.slice(0, max),
		truncated: merged.length > max
	};
}
/** Case-insensitive, slash-normalized form used only for prefix matching. */
function normalizeForMatch(path) {
	let p = path.replace(/\\/g, "/").toLowerCase();
	while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	return p;
}
function workspaceForCwd(cwd, workspaces) {
	if (typeof cwd !== "string" || cwd === "") return undefined;
	const target = normalizeForMatch(cwd);
	let best;
	for (const workspace of workspaces) {
		if (typeof workspace.id !== "string" || typeof workspace.path !== "string") continue;
		const base = normalizeForMatch(workspace.path);
		if (base === "") continue;
		if (target !== base && !target.startsWith(base + "/")) continue;
		if (best === undefined || base.length > best.length) best = {
			id: workspace.id,
			length: base.length
		};
	}
	return best?.id;
}
function escapePromptBraces(text) {
	return text.replaceAll("{{", "&#123;&#123;");
}
function buildInjectionMessage(name, renderedText) {
	return {
		content: [{
			type: "text",
			text: renderedText
		}],
		source: {
			kind: "skill-invocation",
			name,
			form: "instructions"
		}
	};
}
function classifySelection(input) {
	const { selected, catalog, scoped, loads } = input;
	const advertised = new Set(catalog.kind === "scoped" ? catalog.names : []);
	const complete = catalog.kind === "scoped" && catalog.complete;
	return selected.map((name) => {
		if (advertised.has(name)) {
			const load = loads.get(name);
			if (load !== undefined && load.ok) return {
				name,
				state: "ready"
			};
			return {
				name,
				state: "load-failed",
				reason: load?.reason || "skill body could not be loaded"
			};
		}
		if (catalog.kind === "error") return {
			name,
			state: "unavailable",
			reason: catalog.reason || "skill catalog read failed"
		};
		if (!complete) return {
			name,
			state: "unavailable",
			reason: "provider discovery incomplete"
		};
		if (!scoped) return {
			name,
			state: "no-scope",
			reason: "waiting for a session to establish scope"
		};
		return {
			name,
			state: "unknown",
			reason: "not in the skill catalog"
		};
	});
}
function applyBodies(prev, rows, fresh) {
	const next = new Map();
	for (const row of rows) {
		if (row.state === "unknown") continue;
		const body = row.state === "ready" ? fresh.get(row.name) : prev.get(row.name);
		if (body !== undefined) next.set(row.name, body);
	}
	return next;
}
function cachedSuffix(input) {
	if (input.cached !== true) return "";
	if (input.mode === "start-only") return input.injected.includes(input.name) ? " · already in this session" : " · last loaded copy retained";
	return " · still injecting the last loaded copy";
}

//#endregion
export { MAX_SELECTED, MODES, applyBodies, buildInjectionMessage, cachedSuffix, classifySelection, escapePromptBraces, isSkillName, mergeSelection, validateSelection, workspaceForCwd };