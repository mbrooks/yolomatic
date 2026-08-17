import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Migration 16: consolidate refinement persistence into `bot-state.sqlite`.
 *
 * Source-of-truth consolidation: refinement data used to live in a separate
 * `refinement.sqlite` file. This migration copies any remaining legacy rows
 * into the canonical `bot-state.sqlite` so `RefinementStore` can read and
 * write the canonical database.
 *
 * The migration is idempotent: a durable marker row is written only after the
 * copy transaction commits, and re-runs are a no-op. The legacy file is never
 * deleted here; cleanup is a separate explicit operational decision (see
 * `design/refinement-migration.md`).
 *
 * SQL is kept local and readable here. There are no generic query builders or
 * shared SQL fragments; column lists are local constants.
 */
export function migrateRefinementStoreIntoBotState(db: DatabaseSync): void {
	// Only run when operating against the canonical database. The shared
	// migration set is also applied to the legacy `refinement.sqlite` by
	// older code paths; copying from a file into itself is a no-op.
	const mainRow = db.prepare("PRAGMA database_list").get() as { file?: string } | undefined;
	const mainFile = mainRow?.file;
	if (!mainFile || !mainFile.endsWith("bot-state.sqlite")) return;

	// Durable marker table. Created on the canonical database even when
	// no legacy file exists so the marker check is reliable across
	// re-runs and fresh installs.
	db.exec(`
		CREATE TABLE IF NOT EXISTS refinement_store_migration (
			id INTEGER PRIMARY KEY,
			source_path TEXT NOT NULL,
			source_size INTEGER NOT NULL,
			attempts_copied INTEGER NOT NULL,
			instructions_copied INTEGER NOT NULL,
			migrated_at TEXT NOT NULL
		)
	`);
	if (db.prepare("SELECT id FROM refinement_store_migration WHERE id = 1").get() !== undefined) return;

	const legacyPath = path.join(path.dirname(mainFile), "refinement.sqlite");
	if (!existsSync(legacyPath)) return;

	// Attach the legacy file and verify it actually holds refinement
	// tables. A stray empty `refinement.sqlite` (e.g. created by an
	// aborted startup) has nothing to copy and is skipped cleanly.
	db.prepare("ATTACH DATABASE ? AS legacy_refinement").run(legacyPath);
	try {
		const legacyTables = db.prepare(
			"SELECT name FROM legacy_refinement.sqlite_master WHERE type='table' AND name IN ('refinement_attempts','refinement_instructions')",
		).all() as Array<{ name: string }>;
		const hasAttemptTable = legacyTables.some((t) => t.name === "refinement_attempts");
		const hasInstructionTable = legacyTables.some((t) => t.name === "refinement_instructions");
		if (!hasAttemptTable && !hasInstructionTable) return;

		const attemptColumns =
			"id, owner, repo, issue_number, instruction_comment_id, command_comment_id, requester, " +
			"original_title, original_body, original_body_fingerprint, proposed_task_body, proposed_title, " +
			"summary, investigation, instruction_source, repo_commit, state, failure_reason, delivery_id, " +
			"steering_prompt, created_at, updated_at";
		const attemptLegacyColumns =
			"l.id, l.owner, l.repo, l.issue_number, l.instruction_comment_id, l.command_comment_id, l.requester, " +
			"l.original_title, l.original_body, l.original_body_fingerprint, l.proposed_task_body, l.proposed_title, " +
			"l.summary, l.investigation, l.instruction_source, l.repo_commit, l.state, l.failure_reason, l.delivery_id, " +
			"l.steering_prompt, l.created_at, l.updated_at";

		db.exec("BEGIN IMMEDIATE");
		try {
			let attemptsCopied = 0;
			let instructionsCopied = 0;

			if (hasAttemptTable) {
				// Copy rows whose id is not already present in the destination.
				const insertNew = db.prepare(
					`INSERT INTO refinement_attempts (${attemptColumns}) ` +
						`SELECT ${attemptLegacyColumns} ` +
						`FROM legacy_refinement.refinement_attempts l ` +
						`WHERE l.id NOT IN (SELECT id FROM refinement_attempts)`,
				);
				attemptsCopied = Number(insertNew.run().changes);

				// Reject any legacy row whose id already exists in the
				// destination with differing content. Identical rows are
				// left untouched. A conflict abort rolls back every row
				// copied above so no partial migration survives.
				const conflict = db.prepare(
					`SELECT l.id FROM legacy_refinement.refinement_attempts l ` +
						`JOIN refinement_attempts d ON d.id = l.id ` +
						`WHERE NOT (` +
							"l.owner IS d.owner AND l.repo IS d.repo AND l.issue_number IS d.issue_number AND " +
							"l.instruction_comment_id IS d.instruction_comment_id AND l.command_comment_id IS d.command_comment_id AND " +
							"l.requester IS d.requester AND l.original_title IS d.original_title AND l.original_body IS d.original_body AND " +
							"l.original_body_fingerprint IS d.original_body_fingerprint AND l.proposed_task_body IS d.proposed_task_body AND " +
							"l.proposed_title IS d.proposed_title AND l.summary IS d.summary AND l.investigation IS d.investigation AND " +
							"l.instruction_source IS d.instruction_source AND l.repo_commit IS d.repo_commit AND l.state IS d.state AND " +
							"l.failure_reason IS d.failure_reason AND l.delivery_id IS d.delivery_id AND l.steering_prompt IS d.steering_prompt AND " +
							"l.created_at IS d.created_at AND l.updated_at IS d.updated_at" +
						`) LIMIT 1`,
				).get() as { id: string } | undefined;
				if (conflict) {
					throw new Error(
						`refinement migration aborted: conflicting attempt id ${conflict.id} differs between legacy and destination`,
					);
				}
			}

			if (hasInstructionTable) {
				const insertNewInstruction = db.prepare(
					`INSERT INTO refinement_instructions (owner, repo, issue_number, comment_id, created_at) ` +
						`SELECT l.owner, l.repo, l.issue_number, l.comment_id, l.created_at ` +
						`FROM legacy_refinement.refinement_instructions l ` +
						`WHERE NOT EXISTS (` +
							`SELECT 1 FROM refinement_instructions d ` +
							`WHERE d.owner IS l.owner AND d.repo IS l.repo AND d.issue_number IS l.issue_number)`,
				);
				instructionsCopied = Number(insertNewInstruction.run().changes);

				const instructionConflict = db.prepare(
					`SELECT l.owner, l.repo, l.issue_number FROM legacy_refinement.refinement_instructions l ` +
						`JOIN refinement_instructions d ` +
							`ON d.owner IS l.owner AND d.repo IS l.repo AND d.issue_number IS l.issue_number ` +
						`WHERE NOT (l.comment_id IS d.comment_id AND l.created_at IS d.created_at) LIMIT 1`,
				).get() as { owner: string; repo: string; issue_number: number } | undefined;
				if (instructionConflict) {
					throw new Error(
						`refinement migration aborted: conflicting instruction record for ` +
							`${instructionConflict.owner}/${instructionConflict.repo}#${instructionConflict.issue_number} differs between legacy and destination`,
					);
				}
			}

			// Durable marker, recorded only inside the committing transaction
			// so it is durable iff the copied rows are durable.
			db.prepare(
				"INSERT INTO refinement_store_migration (id, source_path, source_size, attempts_copied, instructions_copied, migrated_at) " +
					"VALUES (1, ?, ?, ?, ?, ?)",
			).run(legacyPath, statSync(legacyPath).size, attemptsCopied, instructionsCopied, new Date().toISOString());

			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.exec("DETACH DATABASE legacy_refinement");
	}
}