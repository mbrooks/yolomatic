import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { WorkspaceConfig } from "./config.js";

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

	const prefixStr = prefix ? `${prefix}:` : "TARS:";
	const prefixLen = prefixStr.length + 1; // +1 for space

	const trimmedSummary = (summary ?? "").trim();
	const summaryLines = trimmedSummary.split(/\r?\n/);
	const firstLine = summaryLines[0] ?? "";
	let subject = firstLine.trim() || `Changes for issue #${issueNumber}`;

	subject = toImperative(subject);

	// Remove trailing period(s)
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

	const wrappedBody = wrapText(body, 72);
	return `${fullSubject}\n\n${wrappedBody}`;
}

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
	owner: string;
	repo: string;
	issueNumber: number;
	path: string;
	branch: string;
}

export interface CommandRunner {
	(
		command: string,
		args: string[],
		options?: {
			cwd?: string;
		},
	): Promise<{ stdout: string; stderr: string }>;
}

function normalizeSegment(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${label} is required`);
	}
	if (!/^[a-zA-Z0-9._-]+$/u.test(trimmed)) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return trimmed;
}

export class WorkspaceManager {
	public constructor(
		private readonly config: WorkspaceConfig,
		private readonly runCommand: CommandRunner = async (command, args, options) => {
			return execFileAsync(command, args, {
				cwd: options?.cwd,
				env: process.env,
			});
		},
	) {}

	getRepoKey(owner: string, repo: string): string {
		return `${normalizeSegment(owner, "owner")}-${normalizeSegment(repo, "repo")}`.toLowerCase();
	}

	getBareRepoPath(owner: string, repo: string): string {
		return path.join(this.config.workspacesDir, this.getRepoKey(owner, repo));
	}

	getWorktreePath(owner: string, repo: string, issueNumber: number): string {
		return path.join(this.getBareRepoPath(owner, repo), ".worktrees", `issue-${issueNumber}`);
	}

	getBranchName(issueNumber: number): string {
		return `tars/issue-${issueNumber}`;
	}

	async createOrGetWorktree(owner: string, repo: string, issueNumber: number): Promise<WorktreeInfo> {
		const normalizedOwner = normalizeSegment(owner, "owner");
		const normalizedRepo = normalizeSegment(repo, "repo");
		const bareRepoPath = this.getBareRepoPath(normalizedOwner, normalizedRepo);
		const worktreePath = this.getWorktreePath(normalizedOwner, normalizedRepo, issueNumber);
		const branchName = this.getBranchName(issueNumber);

		await mkdir(this.config.workspacesDir, { recursive: true });
		await this.ensureBareRepo(normalizedOwner, normalizedRepo);

		if (await this.worktreeExists(bareRepoPath, worktreePath)) {
			return {
				owner: normalizedOwner,
				repo: normalizedRepo,
				issueNumber,
				path: worktreePath,
				branch: branchName,
			};
		}

		await this.pruneWorktrees(bareRepoPath);

		const existsBranch = await this.branchExists(bareRepoPath, branchName);
		await this.updateDefaultBranch(bareRepoPath);
		const baseRef = await this.resolveBaseRef(bareRepoPath);

		try {
			if (existsBranch) {
				await this.runCommand("git", ["branch", "-f", branchName, baseRef], { cwd: bareRepoPath });
				await this.runCommand("git", ["worktree", "add", "--force", worktreePath, branchName], {
					cwd: bareRepoPath,
				});
			} else {
				await this.runCommand(
					"git",
					["worktree", "add", worktreePath, "-b", branchName, baseRef],
					{
						cwd: bareRepoPath,
					},
				);
			}
		} catch (error) {
			const originalMessage = error instanceof Error ? error.message : String(error);
			throw new Error(
				`[workspace] ERROR: Cannot create worktree for ${branchName}\n\n` +
					`Possible causes:\n` +
					`1. The branch is already checked out in another worktree that still exists.\n` +
					`2. A previous worktree was deleted outside of git, leaving a stale registry entry.\n\n` +
					`How to recover:\n` +
					`- Check existing worktrees: git worktree list\n` +
					`- Remove stale worktree: git worktree remove <path>\n` +
					`- If directory is already gone: git worktree prune\n` +
					`- Force remove if needed: git worktree remove --force <path>\n\n` +
					`Attempting automatic recovery via 'git worktree prune'...\n\n` +
					`Original error: ${originalMessage}`,
			);
		}

		return {
			owner: normalizedOwner,
			repo: normalizedRepo,
			issueNumber,
			path: worktreePath,
			branch: branchName,
		};
	}

	async removeWorktree(owner: string, repo: string, issueNumber: number): Promise<void> {
		const bareRepoPath = this.getBareRepoPath(owner, repo);
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);

		if (await this.worktreeExists(bareRepoPath, worktreePath)) {
			await this.runCommand("git", ["worktree", "remove", worktreePath], {
				cwd: bareRepoPath,
			});
		}
	}

	async commitAndPush(owner: string, repo: string, issueNumber: number, message?: string): Promise<boolean> {
		const worktreePath = this.getWorktreePath(owner, repo, issueNumber);
		const branchName = this.getBranchName(issueNumber);

		await this.ensureGitIdentity(worktreePath);
		await this.runCommand("git", ["add", "-A"], { cwd: worktreePath });

		const hasStagedChanges = await this.hasChanges(worktreePath, true);
		if (hasStagedChanges) {
			await this.runCommand(
				"git",
				["commit", "-m", message ?? `TARS: Changes for issue #${issueNumber}`],
				{ cwd: worktreePath },
			);
		}

		// If there are no staged changes and the branch has no commits ahead of the
		// base branch, there's nothing to deliver. Pushing would create an empty branch
		// that causes GitHub to reject PR creation with "No commits between ...".
		if (!hasStagedChanges && !(await this.branchHasCommitsAhead(worktreePath))) {
			return false;
		}

		await this.runCommand("git", ["push", "origin", branchName], { cwd: worktreePath });
		return true;
	}

	private async branchHasCommitsAhead(worktreePath: string): Promise<boolean> {
		try {
			const { stdout } = await this.runCommand(
				"git",
				["rev-list", "--count", `origin/${this.config.defaultBranch}..HEAD`],
				{ cwd: worktreePath },
			);
			return parseInt(stdout.trim(), 10) > 0;
		} catch {
			return false;
		}
	}

	private async ensureGitIdentity(worktreePath: string): Promise<void> {
		const name = "TARS";
		const email = `${this.config.githubUsername}@users.noreply.github.com`;

		await this.runCommand("git", ["config", "user.name", name], { cwd: worktreePath });
		await this.runCommand("git", ["config", "user.email", email], { cwd: worktreePath });
	}

	private async ensureBareRepo(owner: string, repo: string): Promise<void> {
		const bareRepoPath = this.getBareRepoPath(owner, repo);

		if (await this.pathExists(bareRepoPath)) {
			await this.runCommand("git", ["fetch", "--all", "--prune"], { cwd: bareRepoPath });
			return;
		}

		const encodedUsername = encodeURIComponent(this.config.githubUsername);
		const encodedToken = encodeURIComponent(this.config.githubToken);
		const url = `https://${encodedUsername}:${encodedToken}@github.com/${owner}/${repo}.git`;

		await this.runCommand("git", ["clone", "--bare", url, bareRepoPath]);
	}

	private async getWorktreeList(bareRepoPath: string): Promise<Array<{ path: string; branch?: string }>> {
		try {
			const { stdout } = await this.runCommand("git", ["worktree", "list", "--porcelain"], {
				cwd: bareRepoPath,
			});
			const worktrees: Array<{ path: string; branch?: string }> = [];
			let current: { path: string; branch?: string } | null = null;
			for (const line of stdout.split("\n")) {
				if (line.startsWith("worktree ")) {
					if (current) {
						worktrees.push(current);
					}
					current = { path: line.slice("worktree ".length) };
				} else if (line.startsWith("branch ") && current) {
					current.branch = line.slice("branch ".length);
				} else if (line === "" && current) {
					worktrees.push(current);
					current = null;
				}
			}
			if (current) {
				worktrees.push(current);
			}
			return worktrees;
		} catch {
			return [];
		}
	}

	private async worktreeExists(bareRepoPath: string, expectedPath: string): Promise<boolean> {
		const worktrees = await this.getWorktreeList(bareRepoPath);
		return worktrees.some((w) => w.path === expectedPath);
	}

	private async pruneWorktrees(bareRepoPath: string): Promise<void> {
		await this.runCommand("git", ["worktree", "prune"], { cwd: bareRepoPath });
	}

	private async branchExists(bareRepoPath: string, branchName: string): Promise<boolean> {
		try {
			await this.runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
				cwd: bareRepoPath,
			});
			return true;
		} catch {
			return false;
		}
	}

	async hasChanges(workspacePath: string, cached = false): Promise<boolean> {
		try {
			const args = cached ? ["diff", "--cached", "--quiet"] : ["diff", "--quiet"];
			await this.runCommand("git", args, { cwd: workspacePath });
			return false;
		} catch {
			return true;
		}
	}

	private async updateDefaultBranch(bareRepoPath: string): Promise<void> {
		await this.runCommand("git", ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*", "--prune"], {
			cwd: bareRepoPath,
		});

		try {
			await this.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: bareRepoPath });
		} catch {
			// Some repositories or older bare clones may not have enough remote
			// metadata for origin/HEAD. resolveBaseRef() has fallbacks.
		}
	}

	private async resolveBaseRef(bareRepoPath: string): Promise<string> {
		const candidates = [
			"origin/HEAD",
			`origin/${this.config.defaultBranch}`,
			`refs/remotes/origin/${this.config.defaultBranch}`,
			this.config.defaultBranch,
			`refs/heads/${this.config.defaultBranch}`,
			"HEAD",
		];

		for (const candidate of candidates) {
			if (await this.refExists(bareRepoPath, candidate)) {
				return candidate;
			}
		}

		try {
			const { stdout } = await this.runCommand("git", ["branch", "-r", "--format=%(refname:short)"], {
				cwd: bareRepoPath,
			});
			const remoteBranches = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "" && line !== "origin/HEAD");

			if (remoteBranches.length === 1 && await this.refExists(bareRepoPath, remoteBranches[0])) {
				return remoteBranches[0];
			}
		} catch {
			// Fall through to diagnostic error below.
		}

		throw new Error(
			`[workspace] ERROR: Cannot resolve base branch in ${bareRepoPath}\n\n` +
				`Tried origin/HEAD, origin/${this.config.defaultBranch}, ${this.config.defaultBranch}, and HEAD.\n` +
				`Check that the remote has at least one branch and that git fetch can read it.`,
		);
	}

	private async refExists(bareRepoPath: string, ref: string): Promise<boolean> {
		try {
			await this.runCommand("git", ["rev-parse", "--verify", ref], { cwd: bareRepoPath });
			return true;
		} catch {
			return false;
		}
	}

	private async pathExists(targetPath: string): Promise<boolean> {
		try {
			await stat(targetPath);
			return true;
		} catch {
			return false;
		}
	}
}
