import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MIGRATIONS, runMigrations } from "./index.js";
import { RefinementStore } from "../refinement/store.js";

const ATTEMPT_COLUMNS =
	"id, owner, repo, issue_number, instruction_comment_id, command_comment_id, requester, " +
	"original_title, original_body, original_body_fingerprint, proposed_task_body, proposed_title, " +
	"summary, investigation, instruction_source, repo_commit, state, failure_reason, delivery_id, " +
	"steering_prompt, created_at, updated_at";

function migration16() {
	const migration = MIGRATIONS.find((entry) => entry.id === 16);
	if (!migration) throw new Error("migration 16 not defined");
	return migration;
}

/**
 * Build a legacy `refinement.sqlite` in `dir` with the full schema (via the
 * shared migration set) and return the open handle so the caller can insert
 * fixture rows. The handle is returned unclosed.
 */
function openLegacy(dir: string): DatabaseSync {
	const legacy = new DatabaseSync(path.join(dir, "refinement.sqlite"));
	legacy.exec("PRAGMA journal_mode = WAL;");
	runMigrations(legacy);
	return legacy;
}

function openDestination(dir: string): DatabaseSync {
	const dest = new DatabaseSync(path.join(dir, "bot-state.sqlite"));
	dest.exec("PRAGMA journal_mode = WAL;");
	runMigrations(dest);
	return dest;
}

function insertAttempt(
	db: DatabaseSync,
	id: string,
	overrides: Partial<{
		owner: string;
		repo: string;
		issue_number: number;
		original_title: string;
		original_body: string;
		state: string;
		proposed_task_body: string | null;
		proposed_title: string | null;
		steering_prompt: string | null;
		delivery_id: string | null;
		failure_reason: string | null;
		created_at: string;
		updated_at: string;
	}> = {},
): void {
	const values = {
		owner: "mbrooks",
		repo: "yolomatic",
		issue_number: 1,
		instruction_comment_id: null,
		command_comment_id: null,
		requester: "admin",
		original_title: "Title",
		original_body: "Body",
		original_body_fingerprint: "fp",
		proposed_task_body: null,
		proposed_title: null,
		summary: null,
		investigation: null,
		instruction_source: "prompt-defaults",
		repo_commit: null,
		state: "applied",
		failure_reason: null,
		delivery_id: null,
		steering_prompt: null,
		created_at: "2026-08-01T00:00:00.000Z",
		updated_at: "2026-08-01T00:00:00.000Z",
		...overrides,
	};
	db.prepare(
		`INSERT INTO refinement_attempts (${ATTEMPT_COLUMNS}) VALUES ` +
			`(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		values.owner,
		values.repo,
		values.issue_number,
		values.instruction_comment_id,
		values.command_comment_id,
		values.requester,
		values.original_title,
		values.original_body,
		values.original_body_fingerprint,
		values.proposed_task_body,
		values.proposed_title,
		values.summary,
		values.investigation,
		values.instruction_source,
		values.repo_commit,
		values.state,
		values.failure_reason,
		values.delivery_id,
		values.steering_prompt,
		values.created_at,
		values.updated_at,
	);
}

function insertInstruction(db: DatabaseSync, owner: string, repo: string, issueNumber: number, commentId: number, createdAt = "2026-08-01T00:00:00.000Z"): void {
	db.prepare(
		"INSERT INTO refinement_instructions (owner, repo, issue_number, comment_id, created_at) VALUES (?, ?, ?, ?, ?)",
	).run(owner, repo, issueNumber, commentId, createdAt);
}

function attemptIds(db: DatabaseSync): string[] {
	const rows = db.prepare("SELECT id FROM refinement_attempts ORDER BY id").all() as Array<{ id: string }>;
	return rows.map((r) => r.id);
}

function instructionRows(db: DatabaseSync): Array<{ owner: string; repo: string; issue_number: number; comment_id: number; created_at: string }> {
	return db.prepare("SELECT owner, repo, issue_number, comment_id, created_at FROM refinement_instructions ORDER BY owner, repo, issue_number").all() as Array<{
		owner: string;
		repo: string;
		issue_number: number;
		comment_id: number;
		created_at: string;
	}>;
}

function markerRow(db: DatabaseSync): { id: number; source_path: string; attempts_copied: number; instructions_copied: number } | undefined {
	return db.prepare("SELECT id, source_path, attempts_copied, instructions_copied FROM refinement_store_migration WHERE id = 1").get() as
		| { id: number; source_path: string; attempts_copied: number; instructions_copied: number }
		| undefined;
}

describe("migration 16: consolidate refinement store into bot-state.sqlite", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "refinement-migration-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("migrates a populated legacy refinement database into an empty destination", () => {
		const legacy = openLegacy(dir);
		insertAttempt(legacy, "a-1", { issue_number: 11, state: "applied", proposed_task_body: "task body" });
		insertAttempt(legacy, "a-2", { issue_number: 12, state: "failed", failure_reason: null, steering_prompt: "focus" });
		insertInstruction(legacy, "mbrooks", "yolomatic", 11, 100);
		insertInstruction(legacy, "mbrooks", "yolomatic", 12, 200);
		legacy.close();

		const dest = openDestination(dir);

		expect(attemptIds(dest).sort()).toEqual(["a-1", "a-2"]);
		expect(instructionRows(dest)).toHaveLength(2);
		const marker = markerRow(dest);
		expect(marker).toBeDefined();
		expect(marker!.source_path).toBe(path.join(dir, "refinement.sqlite"));
		expect(marker!.attempts_copied).toBe(2);
		expect(marker!.instructions_copied).toBe(2);
		// Legacy file preserved (rollback path).
		expect(existsSync(path.join(dir, "refinement.sqlite"))).toBe(true);
		dest.close();
	});

	it("re-running the migration does not duplicate or change rows", () => {
		const legacy = openLegacy(dir);
		insertAttempt(legacy, "a-1", { issue_number: 11 });
		insertInstruction(legacy, "mbrooks", "yolomatic", 11, 100);
		legacy.close();

		const dest = openDestination(dir);
		const attemptsBefore = attemptIds(dest);
		const instructionsBefore = instructionRows(dest);
		const markerBefore = markerRow(dest);

		migration16().up(dest);

		expect(attemptIds(dest)).toEqual(attemptsBefore);
		expect(instructionRows(dest)).toEqual(instructionsBefore);
		// Single marker row.
		const markers = dest.prepare("SELECT id FROM refinement_store_migration").all() as Array<{ id: number }>;
		expect(markers).toHaveLength(1);
		expect(markerRow(dest)).toEqual(markerBefore);
		dest.close();
	});

	it("preserves existing identical destination rows and copies only new rows", () => {
		const legacy = openLegacy(dir);
		insertAttempt(legacy, "shared", { issue_number: 50, original_title: "Same" });
		insertAttempt(legacy, "only-legacy", { issue_number: 51, original_title: "New" });
		insertInstruction(legacy, "mbrooks", "yolomatic", 50, 500);
		insertInstruction(legacy, "mbrooks", "yolomatic", 51, 510);
		legacy.close();

		// Pre-seed destination with the identical "shared" row + instruction.
		const dest = new DatabaseSync(path.join(dir, "bot-state.sqlite"));
		dest.exec("PRAGMA journal_mode = WAL;");
		// Run all migrations EXCEPT 16 so we control destination state.
		for (const m of MIGRATIONS.filter((entry) => entry.id < 16)) m.up(dest);
		insertAttempt(dest, "shared", { issue_number: 50, original_title: "Same" });
		insertInstruction(dest, "mbrooks", "yolomatic", 50, 500);
		// Now run migration 16.
		migration16().up(dest);

		expect(attemptIds(dest).sort()).toEqual(["only-legacy", "shared"]);
		const shared = dest.prepare("SELECT original_title, issue_number, updated_at FROM refinement_attempts WHERE id = 'shared'").get() as {
			original_title: string;
			issue_number: number;
			updated_at: string;
		};
		// Identical row preserved untouched.
		expect(shared.original_title).toBe("Same");
		expect(instructionRows(dest)).toHaveLength(2);
		expect(markerRow(dest)).toBeDefined();
		expect(markerRow(dest)!.attempts_copied).toBe(1);
		expect(markerRow(dest)!.instructions_copied).toBe(1);
		dest.close();
	});

	it("rejects conflicting attempt ids without silent data loss and rolls back copied rows", () => {
		const legacy = openLegacy(dir);
		insertAttempt(legacy, "conflict", { issue_number: 70, original_title: "Legacy" });
		insertAttempt(legacy, "new-1", { issue_number: 71, original_title: "New One" });
		insertAttempt(legacy, "new-2", { issue_number: 72, original_title: "New Two" });
		legacy.close();

		const dest = new DatabaseSync(path.join(dir, "bot-state.sqlite"));
		dest.exec("PRAGMA journal_mode = WAL;");
		for (const m of MIGRATIONS.filter((entry) => entry.id < 16)) m.up(dest);
		// Destination already has id "conflict" with DIFFERENT content.
		insertAttempt(dest, "conflict", { issue_number: 70, original_title: "Destination" });

		expect(() => migration16().up(dest)).toThrow();

		// No new rows landed (rollback).
		expect(attemptIds(dest)).toEqual(["conflict"]);
		const kept = dest.prepare("SELECT original_title FROM refinement_attempts WHERE id = 'conflict'").get() as { original_title: string };
		expect(kept.original_title).toBe("Destination");
		// No marker recorded.
		expect(markerRow(dest)).toBeUndefined();
		dest.close();
	});

	it("rejects conflicting instruction records without silent data loss", () => {
		const legacy = openLegacy(dir);
		insertInstruction(legacy, "mbrooks", "yolomatic", 80, 800, "2026-08-01T00:00:00.000Z");
		legacy.close();

		const dest = new DatabaseSync(path.join(dir, "bot-state.sqlite"));
		dest.exec("PRAGMA journal_mode = WAL;");
		for (const m of MIGRATIONS.filter((entry) => entry.id < 16)) m.up(dest);
		// Same composite key, different comment_id.
		insertInstruction(dest, "mbrooks", "yolomatic", 80, 999, "2026-09-01T00:00:00.000Z");

		expect(() => migration16().up(dest)).toThrow();

		const rows = instructionRows(dest);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.comment_id).toBe(999);
		expect(markerRow(dest)).toBeUndefined();
		dest.close();
	});

	it("starts cleanly when no legacy database exists", () => {
		const dest = openDestination(dir);
		expect(attemptIds(dest)).toEqual([]);
		expect(instructionRows(dest)).toEqual([]);
		expect(markerRow(dest)).toBeUndefined();
		// Legacy file was never created.
		expect(existsSync(path.join(dir, "refinement.sqlite"))).toBe(false);
		dest.close();
	});

	it("skips gracefully when the legacy file exists but lacks refinement tables", () => {
		// Create a stray empty file that is a valid SQLite db but has no schema.
		const stray = new DatabaseSync(path.join(dir, "refinement.sqlite"));
		stray.exec("CREATE TABLE unrelated (x INTEGER)");
		stray.close();

		const dest = openDestination(dir);
		expect(attemptIds(dest)).toEqual([]);
		expect(markerRow(dest)).toBeUndefined();
		dest.close();
	});

	it("reads historical attempts and instruction records through RefinementStore after migration", () => {
		const legacy = openLegacy(dir);
		insertAttempt(legacy, "hist-1", {
			issue_number: 100,
			state: "applied",
			proposed_task_body: "proposed",
			steering_prompt: "steer",
			proposed_title: "Proposed Title",
			delivery_id: "del-1",
		});
		insertInstruction(legacy, "mbrooks", "yolomatic", 100, 1000);
		legacy.close();

		// Run the full migration set on bot-state (includes migration 16).
		const dest = openDestination(dir);
		dest.close();

		// Open through RefinementStore pointing at bot-state.sqlite.
		const store = new RefinementStore(path.join(dir, "bot-state.sqlite"));
		const latest = store.getLatestAttempt("mbrooks", "yolomatic", 100);
		expect(latest).not.toBeNull();
		expect(latest!.id).toBe("hist-1");
		expect(latest!.proposedTaskBody).toBe("proposed");
		expect(latest!.steeringPrompt).toBe("steer");
		expect(latest!.proposedTitle).toBe("Proposed Title");
		expect(latest!.deliveryId).toBe("del-1");

		const byId = store.getAttempt("hist-1");
		expect(byId).not.toBeNull();
		expect(byId!.state).toBe("applied");

		const instruction = store.getInstructionComment("mbrooks", "yolomatic", 100);
		expect(instruction).not.toBeNull();
		expect(instruction!.commentId).toBe(1000);

		const byDelivery = store.getAttemptByDeliveryId("del-1");
		expect(byDelivery).not.toBeNull();
		expect(byDelivery!.id).toBe("hist-1");
	});

	it("does not run the copy when the open database is not bot-state.sqlite", () => {
		// A standalone refinement.sqlite (e.g. opened by an older code path)
		// must not try to copy from a sibling "refinement.sqlite" (itself).
		const legacy = openLegacy(dir);
		insertAttempt(legacy, "self-1", { issue_number: 1 });
		legacy.close();

		// Re-open the legacy file and run migration 16 directly against it.
		const db = new DatabaseSync(path.join(dir, "refinement.sqlite"));
		db.exec("PRAGMA journal_mode = WAL;");
		runMigrations(db);

		// No marker recorded against the legacy file.
		const marker = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='refinement_store_migration'").get();
		expect(marker).toBeUndefined();
		expect(attemptIds(db)).toEqual(["self-1"]);
		db.close();
	});
});