const PREFIX_MAP: Record<string, string> = {
	bug: "fix",
	enhancement: "feat",
	feature: "feat",
	documentation: "docs",
	docs: "docs",
	test: "test",
	testing: "test",
	refactor: "refactor",
	chore: "chore",
	style: "style",
	perf: "perf",
	performance: "perf",
	ci: "ci",
	build: "build",
};

const PAST_TO_IMP: Record<string, string> = {
	added: "add",
	adjusted: "adjust",
	aggregated: "aggregate",
	aligned: "align",
	allowed: "allow",
	analyzed: "analyze",
	archived: "archive",
	arranged: "arrange",
	assembled: "assemble",
	assigned: "assign",
	attached: "attach",
	authenticated: "authenticate",
	bound: "bind",
	built: "build",
	bundled: "bundle",
	calculated: "calculate",
	calibrated: "calibrate",
	captured: "capture",
	carved: "carve",
	centered: "center",
	changed: "change",
	checked: "check",
	chopped: "chop",
	cleaned: "clean",
	cloned: "clone",
	collapsed: "collapse",
	collected: "collect",
	commissioned: "commission",
	compiled: "compile",
	completed: "complete",
	compressed: "compress",
	computed: "compute",
	condensed: "condense",
	configured: "configure",
	consolidated: "consolidate",
	converted: "convert",
	copied: "copy",
	counted: "count",
	created: "create",
	decreased: "decrease",
	deleted: "delete",
	delayed: "delay",
	delegated: "delegate",
	demonstrated: "demonstrate",
	deployed: "deploy",
	derived: "derive",
	described: "describe",
	designed: "design",
	determined: "determine",
	developed: "develop",
	differentiated: "differentiate",
	directed: "direct",
	disabled: "disable",
	displayed: "display",
	documented: "document",
	drafted: "draft",
	dragged: "drag",
	dropped: "drop",
	eliminated: "eliminate",
	enabled: "enable",
	encoded: "encode",
	enhanced: "enhance",
	ensured: "ensure",
	estimated: "estimate",
	evaluated: "evaluate",
	executed: "execute",
	expanded: "expand",
	extracted: "extract",
	fixed: "fix",
	flattened: "flatten",
	formatted: "format",
	formed: "form",
	gathered: "gather",
	generated: "generate",
	governed: "govern",
	grouped: "group",
	guided: "guide",
	handled: "handle",
	highlighted: "highlight",
	identified: "identify",
	implemented: "implement",
	improved: "improve",
	increased: "increase",
	indented: "indent",
	installed: "install",
	integrated: "integrate",
	inverted: "invert",
	invoked: "invoke",
	joined: "join",
	justified: "justify",
	led: "lead",
	limited: "limit",
	linked: "link",
	loaded: "load",
	localized: "localize",
	locked: "lock",
	logged: "log",
	managed: "manage",
	mapped: "map",
	marked: "mark",
	measured: "measure",
	merged: "merge",
	migrated: "migrate",
	modified: "modify",
	monitored: "monitor",
	moved: "move",
	normalized: "normalize",
	opened: "open",
	optimized: "optimize",
	orchestrated: "orchestrate",
	organized: "organize",
	outlined: "outline",
	packed: "pack",
	parsed: "parse",
	patched: "patch",
	planned: "plan",
	prepared: "prepare",
	pressed: "press",
	prevented: "prevent",
	prioritized: "prioritize",
	produced: "produce",
	protected: "protect",
	published: "publish",
	raised: "raise",
	realigned: "realign",
	rebuilt: "rebuild",
	received: "receive",
	reduced: "reduce",
	refactored: "refactor",
	refreshed: "refresh",
	registered: "register",
	regulated: "regulate",
	removed: "remove",
	rendered: "render",
	renewed: "renew",
	repaired: "repair",
	replaced: "replace",
	replicated: "replicate",
	reported: "report",
	represented: "represent",
	restored: "restore",
	restricted: "restrict",
	resumed: "resume",
	reverted: "revert",
	rotated: "rotate",
	rounded: "round",
	scaled: "scale",
	scheduled: "schedule",
	scrolled: "scroll",
	secured: "secure",
	selected: "select",
	separated: "separate",
	serialized: "serialize",
	shifted: "shift",
	shown: "show",
	sketched: "sketch",
	sorted: "sort",
	split: "split",
	standardized: "standardize",
	started: "start",
	stopped: "stop",
	structured: "structure",
	styled: "style",
	summarized: "summarize",
	switched: "switch",
	tagged: "tag",
	tailored: "tailor",
	tested: "test",
	toggled: "toggle",
	traced: "trace",
	tracked: "track",
	transferred: "transfer",
	transformed: "transform",
	translated: "translate",
	typed: "type",
	unchecked: "uncheck",
	unified: "unify",
	updated: "update",
	verified: "verify",
	wrapped: "wrap",
	zoomed: "zoom",
};

function stripMarkdown(text: string): string {
	return text
		.replace(/```(?:\w+)?\n?[\s\S]*?```/g, "")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/#{1,6}\s+/g, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.trim();
}

function preserveCase(original: string, replacement: string): string {
	if (original === original.toUpperCase()) {
		return replacement.toUpperCase();
	}
	if (original[0] === original[0].toUpperCase()) {
		return replacement.charAt(0).toUpperCase() + replacement.slice(1);
	}
	return replacement;
}

function toImperative(subject: string): string {
	const words = subject.trim().split(/\s+/);
	if (words.length === 0) return subject;
	const firstLower = words[0].toLowerCase();
	const replacement = PAST_TO_IMP[firstLower];
	if (!replacement) return subject;
	words[0] = preserveCase(words[0], replacement);
	return words.join(" ");
}

function wrapText(text: string, maxWidth = 72): string {
	const lines = text.split(/\r?\n/);
	const result: string[] = [];
	let paragraph: string[] = [];

	function flushParagraph() {
		if (paragraph.length === 0) return;
		const words = paragraph.join(" ").trim().split(/\s+/);
		let current = "";
		for (const word of words) {
			if (current === "") {
				current = word;
			} else if (current.length + 1 + word.length > maxWidth) {
				result.push(current);
				current = word;
			} else {
				current += " " + word;
			}
		}
		if (current) result.push(current);
		paragraph = [];
	}

	for (const line of lines) {
		if (line.trim() === "") {
			flushParagraph();
			result.push("");
		} else if (/^[-*+]\s/.test(line) || /^\d+\.\s/.test(line)) {
			flushParagraph();
			const trimmed = line.trim();
			if (trimmed.length <= maxWidth) {
				result.push(trimmed);
			} else {
				const markerMatch = trimmed.match(/^([-*+]\s|\d+\.\s)/);
				const marker = markerMatch ? markerMatch[0] : "";
				const rest = trimmed.slice(marker.length);
				const words = rest.split(/\s+/);
				const indent = " ".repeat(marker.length);
				let current = marker;
				for (const word of words) {
					if (current === marker) {
						current += word;
					} else if (current.length + 1 + word.length > maxWidth) {
						result.push(current);
						current = indent + word;
					} else {
						current += " " + word;
					}
				}
				if (current) result.push(current);
			}
		} else {
			paragraph.push(line.trim());
		}
	}

	flushParagraph();
	return result.join("\n");
}

export function generateCommitMessage(
	labels: string[] | undefined,
	issueNumber: number,
	summary?: string,
): string {
	const labelSet = new Set((labels ?? []).map((l) => l.toLowerCase()));
	let prefix: string | undefined;
	for (const [label, p] of Object.entries(PREFIX_MAP)) {
		if (labelSet.has(label)) {
			prefix = p;
			break;
		}
	}

	const prefixStr = prefix ? `${prefix}:` : "Yeetomatic:";
	const prefixLen = prefixStr.length + 1;

	const trimmedSummary = stripMarkdown(summary ?? "").trim();
	const summaryLines = trimmedSummary.split(/\r?\n/);
	const firstLine = summaryLines[0] ?? "";
	let subject = firstLine.trim() || `Changes for issue #${issueNumber}`;

	subject = toImperative(subject);
	subject = subject.replace(/\.+$/u, "");

	const softMax = 50;
	const hardMax = 72;

	if (prefixLen + subject.length > softMax) {
		const targetLen = softMax - prefixLen;
		let truncated = subject.slice(0, targetLen);
		const lastSpace = truncated.lastIndexOf(" ");
		if (lastSpace > targetLen * 0.5) {
			truncated = truncated.slice(0, lastSpace);
		}
		subject = truncated.trimEnd();
	}

	if (prefixLen + subject.length > hardMax) {
		subject = subject.slice(0, hardMax - prefixLen).trimEnd();
	}

	const bodyLines = summaryLines.slice(1);
	while (bodyLines.length > 0 && bodyLines[0].trim() === "") {
		bodyLines.shift();
	}
	const body = bodyLines.join("\n").trim();

	const fullSubject = `${prefixStr} ${subject}`;
	if (!body) {
		return fullSubject;
	}

	return `${fullSubject}\n\n${wrapText(body, 72)}`;
}
