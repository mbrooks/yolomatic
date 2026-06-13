import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runMigrations } from "../migrations/index.js";
import type { GitHubEvent, GitHubEventStateStore, GitHubPollSubject } from "./model.js";

const LAST_EVENT_RECEIVED_AT = "last_event_received_at";

export class GitHubEventStore implements GitHubEventStateStore {
	private readonly db: DatabaseSync;
	private readonly getStateStmt: StatementSync;
	private readonly upsertStateStmt: StatementSync;
	private readonly hasSeenStmt: StatementSync;
	private readonly markSeenStmt: StatementSync;
	private readonly upsertSubjectStmt: StatementSync;
	private readonly listSubjectsStmt: StatementSync;
	private readonly markSubjectCheckedStmt: StatementSync;

	constructor(dbPath: string) {
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		runMigrations(this.db);
		this.getStateStmt = this.db.prepare("SELECT value FROM github_event_state WHERE key = ?");
		this.upsertStateStmt = this.db.prepare(
			`INSERT INTO github_event_state (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		);
		this.hasSeenStmt = this.db.prepare("SELECT event_id FROM github_event_dedupe WHERE event_id = ?");
		this.markSeenStmt = this.db.prepare(
			`INSERT OR IGNORE INTO github_event_dedupe
			 (event_id, owner, repo, event_type, occurred_at, seen_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		this.upsertSubjectStmt = this.db.prepare(
			`INSERT INTO github_poll_subjects
			 (subject_key, owner, repo, subject_type, number, last_activity_at, last_checked_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(subject_key) DO UPDATE SET
			 owner=excluded.owner,
			 repo=excluded.repo,
			 subject_type=excluded.subject_type,
			 number=excluded.number,
			 last_activity_at=excluded.last_activity_at,
			 last_checked_at=excluded.last_checked_at,
			 updated_at=excluded.updated_at`,
		);
		this.listSubjectsStmt = this.db.prepare(
			`SELECT subject_key, owner, repo, subject_type, number, last_activity_at, last_checked_at, created_at
			 FROM github_poll_subjects
			 ORDER BY owner, repo, subject_type, number`,
		);
		this.markSubjectCheckedStmt = this.db.prepare(
			`UPDATE github_poll_subjects SET last_checked_at = ?, updated_at = ? WHERE subject_key = ?`,
		);
	}

	getLastEventReceivedAt(): string | null {
		const row = this.getStateStmt.get(LAST_EVENT_RECEIVED_AT) as { value?: string } | undefined;
		return row?.value ?? null;
	}

	initializeLastEventReceivedAt(value: string): void {
		if (this.getLastEventReceivedAt()) return;
		this.updateLastEventReceivedAt(value);
	}

	updateLastEventReceivedAt(value: string): void {
		this.upsertStateStmt.run(LAST_EVENT_RECEIVED_AT, value, new Date().toISOString());
	}

	hasSeen(eventId: string): boolean {
		return !!this.hasSeenStmt.get(eventId);
	}

	markSeen(event: GitHubEvent): void {
		this.markSeenStmt.run(event.id, event.owner, event.repo, event.type, event.occurredAt, new Date().toISOString());
	}

	upsertPollingSubject(subject: GitHubPollSubject): void {
		const now = new Date().toISOString();
		this.upsertSubjectStmt.run(
			subject.subjectKey,
			subject.owner,
			subject.repo,
			subject.subjectType,
			subject.number,
			subject.lastActivityAt,
			subject.lastCheckedAt,
			subject.createdAt,
			now,
		);
	}

	listPollingSubjects(): GitHubPollSubject[] {
		const rows = this.listSubjectsStmt.all() as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			subjectKey: String(row.subject_key),
			owner: String(row.owner),
			repo: String(row.repo),
			subjectType: String(row.subject_type) === "pull_request" ? "pull_request" : "issue",
			number: Number(row.number),
			lastActivityAt: String(row.last_activity_at),
			lastCheckedAt: row.last_checked_at === null ? null : String(row.last_checked_at),
			createdAt: String(row.created_at),
		}));
	}

	markPollingSubjectChecked(subjectKey: string, checkedAt: string): void {
		this.markSubjectCheckedStmt.run(checkedAt, new Date().toISOString(), subjectKey);
	}
}
