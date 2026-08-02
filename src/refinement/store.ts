import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { runMigrations } from "../migrations/index.js";

export type RefinementState = "instructed" | "running" | "applied" | "stale" | "failed";
export type InstructionSource = "repository-skill" | "prompt-defaults";

export interface RefinementAttempt {
	id: string;
	owner: string;
	repo: string;
	issueNumber: number;
	instructionCommentId?: number;
	commandCommentId?: number;
	requester: string;
	originalTitle: string;
	originalBody: string;
	originalBodyFingerprint: string;
	proposedTaskBody?: string;
	summary?: string;
	investigation?: string;
	instructionSource: InstructionSource;
	repoCommit?: string;
	state: RefinementState;
	failureReason?: string;
	deliveryId?: string;
	steeringPrompt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface RefinementInstructionRecord {
	owner: string;
	repo: string;
	issueNumber: number;
	commentId: number;
	createdAt: string;
}

export interface RefinementAttemptCreate {
	owner: string;
	repo: string;
	issueNumber: number;
	instructionCommentId?: number;
	commandCommentId?: number;
	requester: string;
	originalTitle: string;
	originalBody: string;
	originalBodyFingerprint: string;
	proposedTaskBody?: string;
	summary?: string;
	investigation?: string;
	instructionSource: InstructionSource;
	repoCommit?: string;
	state: RefinementState;
	failureReason?: string;
	deliveryId?: string;
	steeringPrompt?: string;
}

export class RefinementStore {
	private readonly db: DatabaseSync;

	constructor(dbPath: string) {
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		runMigrations(this.db);
	}

	createAttempt(input: RefinementAttemptCreate): RefinementAttempt {
		const now = new Date().toISOString();
		const id = randomUUID();
		const attempt: RefinementAttempt = {
			id,
			...input,
			createdAt: now,
			updatedAt: now,
		};
		const stmt = this.db.prepare(`
			INSERT INTO refinement_attempts (
				id, owner, repo, issue_number, instruction_comment_id, command_comment_id, requester,
				original_title, original_body, original_body_fingerprint, proposed_task_body, summary,
				investigation, instruction_source, repo_commit, state, failure_reason, delivery_id,
				steering_prompt, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			attempt.id,
			attempt.owner,
			attempt.repo,
			attempt.issueNumber,
			attempt.instructionCommentId ?? null,
			attempt.commandCommentId ?? null,
			attempt.requester,
			attempt.originalTitle,
			attempt.originalBody,
			attempt.originalBodyFingerprint,
			attempt.proposedTaskBody ?? null,
			attempt.summary ?? null,
			attempt.investigation ?? null,
			attempt.instructionSource,
			attempt.repoCommit ?? null,
			attempt.state,
			attempt.failureReason ?? null,
			attempt.deliveryId ?? null,
			attempt.steeringPrompt ?? null,
			attempt.createdAt,
			attempt.updatedAt,
		);
		return attempt;
	}

	updateAttempt(id: string, updates: Partial<Omit<RefinementAttempt, "id" | "createdAt">>): RefinementAttempt {
		const attempt = this.getAttempt(id);
		if (!attempt) {
			throw new Error(`Refinement attempt ${id} not found`);
		}
		const allowed = new Set([
			"instructionCommentId",
			"commandCommentId",
			"requester",
			"originalTitle",
			"originalBody",
			"originalBodyFingerprint",
			"proposedTaskBody",
			"summary",
			"investigation",
			"instructionSource",
			"repoCommit",
			"state",
			"failureReason",
			"deliveryId",
		]);
		const sets: string[] = [];
		const values: (string | number | null)[] = [];
		for (const [key, value] of Object.entries(updates)) {
			if (!allowed.has(key)) continue;
			const column = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
			sets.push(`${column} = ?`);
			values.push((value ?? null) as string | number | null);
		}
		values.push(new Date().toISOString());
		values.push(id);
		const sql = `UPDATE refinement_attempts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`;
		this.db.prepare(sql).run(...values);
		const updated = this.getAttempt(id);
		if (!updated) {
			throw new Error(`Refinement attempt ${id} disappeared during update`);
		}
		return updated;
	}

	getAttempt(id: string): RefinementAttempt | null {
		const stmt = this.db.prepare("SELECT * FROM refinement_attempts WHERE id = ?");
		const row = stmt.get(id) as Record<string, unknown> | undefined;
		return row ? this.rowToAttempt(row) : null;
	}

	getAttemptByDeliveryId(deliveryId: string): RefinementAttempt | null {
		const stmt = this.db.prepare("SELECT * FROM refinement_attempts WHERE delivery_id = ? ORDER BY created_at DESC LIMIT 1");
		const row = stmt.get(deliveryId) as Record<string, unknown> | undefined;
		return row ? this.rowToAttempt(row) : null;
	}

	getLatestAttempt(owner: string, repo: string, issueNumber: number): RefinementAttempt | null {
		const stmt = this.db.prepare(
			"SELECT * FROM refinement_attempts WHERE owner = ? AND repo = ? AND issue_number = ? ORDER BY created_at DESC LIMIT 1",
		);
		const row = stmt.get(owner, repo, issueNumber) as Record<string, unknown> | undefined;
		return row ? this.rowToAttempt(row) : null;
	}

	recordInstructionComment(owner: string, repo: string, issueNumber: number, commentId: number): RefinementInstructionRecord {
		const now = new Date().toISOString();
		const stmt = this.db.prepare(`
			INSERT INTO refinement_instructions (owner, repo, issue_number, comment_id, created_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(owner, repo, issue_number) DO UPDATE SET comment_id = excluded.comment_id, created_at = excluded.created_at
		`);
		stmt.run(owner, repo, issueNumber, commentId, now);
		return { owner, repo, issueNumber, commentId, createdAt: now };
	}

	getInstructionComment(owner: string, repo: string, issueNumber: number): RefinementInstructionRecord | null {
		const stmt = this.db.prepare("SELECT * FROM refinement_instructions WHERE owner = ? AND repo = ? AND issue_number = ?");
		const row = stmt.get(owner, repo, issueNumber) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			owner: String(row.owner),
			repo: String(row.repo),
			issueNumber: Number(row.issue_number),
			commentId: Number(row.comment_id),
			createdAt: String(row.created_at),
		};
	}

	listAttemptsByIssue(owner: string, repo: string, issueNumber: number): RefinementAttempt[] {
		const stmt = this.db.prepare(
			"SELECT * FROM refinement_attempts WHERE owner = ? AND repo = ? AND issue_number = ? ORDER BY created_at DESC",
		);
		const rows = stmt.all(owner, repo, issueNumber) as Record<string, unknown>[];
		return rows.map((row) => this.rowToAttempt(row));
	}

	private rowToAttempt(row: Record<string, unknown>): RefinementAttempt {
		return {
			id: String(row.id),
			owner: String(row.owner),
			repo: String(row.repo),
			issueNumber: Number(row.issue_number),
			instructionCommentId: row.instruction_comment_id == null ? undefined : Number(row.instruction_comment_id),
			commandCommentId: row.command_comment_id == null ? undefined : Number(row.command_comment_id),
			requester: String(row.requester),
			originalTitle: String(row.original_title),
			originalBody: String(row.original_body),
			originalBodyFingerprint: String(row.original_body_fingerprint),
			proposedTaskBody: row.proposed_task_body == null ? undefined : String(row.proposed_task_body),
			summary: row.summary == null ? undefined : String(row.summary),
			investigation: row.investigation == null ? undefined : String(row.investigation),
			instructionSource: String(row.instruction_source) as InstructionSource,
			repoCommit: row.repo_commit == null ? undefined : String(row.repo_commit),
			state: String(row.state) as RefinementState,
			failureReason: row.failure_reason == null ? undefined : String(row.failure_reason),
			deliveryId: row.delivery_id == null ? undefined : String(row.delivery_id),
			steeringPrompt: row.steering_prompt == null ? undefined : String(row.steering_prompt),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}
}
