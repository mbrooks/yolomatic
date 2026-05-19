import { DatabaseSync, type StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type CronScheduleType = "daily" | "weekly" | "interval" | "custom";

export interface CronJob {
	id: string;
	owner: string;
	repo: string;
	name: string;
	description: string;
	prompt: string;
	scheduleType: CronScheduleType;
	scheduleValue: string;
	branch: string;
	notificationChannel: string | null;
	enabled: boolean;
	nextRunAt: string;
	lastRunAt: string | null;
	lastRunStatus: "success" | "failure" | null;
	lastError: string | null;
	createdAt: string;
}

export interface CronRun {
	id: string;
	cronId: string;
	owner: string;
	repo: string;
	startedAt: string;
	finishedAt: string;
	status: "success" | "failure";
	output: string;
	error: string | null;
}

const DOW_MAP: Record<string, number> = {
	sun: 0, sunday: 0,
	mon: 1, monday: 1,
	tue: 2, tuesday: 2,
	wed: 3, wednesday: 3,
	thu: 4, thursday: 4,
	fri: 5, friday: 5,
	sat: 6, saturday: 6,
};

function parseTime(timeStr: string): { hour: number; minute: number } {
	const match = timeStr.match(/^(\d{2}):(\d{2})$/u);
	if (!match) {
		throw new Error("Invalid time format. Use HH:MM (24h).");
	}
	const hour = Number.parseInt(match[1], 10);
	const minute = Number.parseInt(match[2], 10);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		throw new Error("Invalid time. Hours must be 00-23 and minutes 00-59.");
	}
	return { hour, minute };
}

function parseWeekly(value: string): { dow: number; hour: number; minute: number } {
	const match = value.match(/^(\w+)\s+(\d{2}):(\d{2})$/u);
	if (!match) {
		throw new Error("Invalid weekly format. Use 'Dow HH:MM' (e.g. Mon 09:00).");
	}
	const dow = DOW_MAP[match[1].toLowerCase()];
	if (dow === undefined) {
		throw new Error(`Invalid day of week: ${match[1]}`);
	}
	const hour = Number.parseInt(match[2], 10);
	const minute = Number.parseInt(match[3], 10);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		throw new Error("Invalid time. Hours must be 00-23 and minutes 00-59.");
	}
	return { dow, hour, minute };
}

function parseInterval(value: string): { unit: "m" | "h"; amount: number; totalMinutes: number } {
	const match = value.trim().match(/^(\d+)([mh])$/u);
	if (!match) {
		throw new Error("Invalid interval format. Use '<amount>m' for minutes or '<amount>h' for hours (e.g. 5m, 2h).");
	}
	const amount = Number.parseInt(match[1], 10);
	const unit = match[2] as "m" | "h";
	const totalMinutes = unit === "m" ? amount : amount * 60;
	if (totalMinutes < 1) {
		throw new Error("Interval must be at least 1 minute.");
	}
	return { unit, amount, totalMinutes };
}

export function computeNextRunAt(
	scheduleType: CronScheduleType,
	scheduleValue: string,
	from = new Date(),
): string {
	if (scheduleType === "daily") {
		const { hour, minute } = parseTime(scheduleValue);
		const candidate = new Date(from);
		candidate.setUTCHours(hour, minute, 0, 0);
		if (candidate.getTime() <= from.getTime()) {
			candidate.setUTCDate(candidate.getUTCDate() + 1);
		}
		return candidate.toISOString();
	}

	if (scheduleType === "weekly") {
		const { dow, hour, minute } = parseWeekly(scheduleValue);
		const candidate = new Date(from);
		candidate.setUTCHours(hour, minute, 0, 0);
		const currentDow = candidate.getUTCDay();
		let daysUntil = dow - currentDow;
		if (daysUntil < 0 || (daysUntil === 0 && candidate.getTime() <= from.getTime())) {
			daysUntil += 7;
		}
		candidate.setUTCDate(candidate.getUTCDate() + daysUntil);
		return candidate.toISOString();
	}

	if (scheduleType === "interval") {
		const { totalMinutes } = parseInterval(scheduleValue);
		const next = new Date(from.getTime() + totalMinutes * 60_000);
		return next.toISOString();
	}

	if (scheduleType === "custom") {
		try {
			return computeNextRunAt("interval", scheduleValue, from);
		} catch {
			try {
				return computeNextRunAt("daily", scheduleValue, from);
			} catch {
				throw new Error("Invalid custom schedule. Use HH:MM for daily, or <amount>h/<amount>m for interval.");
			}
		}
	}

	throw new Error(`Unsupported schedule type: ${scheduleType}`);
}

function rowToCronJob(row: Record<string, unknown>): CronJob {
	return {
		id: String(row.id),
		owner: String(row.owner),
		repo: String(row.repo),
		name: String(row.name),
		description: String(row.description),
		prompt: String(row.prompt),
		scheduleType: String(row.scheduleType) as CronScheduleType,
		scheduleValue: String(row.scheduleValue),
		branch: String(row.branch),
		notificationChannel: row.notificationChannel === null ? null : String(row.notificationChannel),
		enabled: Number(row.enabled) === 1,
		nextRunAt: String(row.nextRunAt),
		lastRunAt: row.lastRunAt === null ? null : String(row.lastRunAt),
		lastRunStatus: row.lastRunStatus === null ? null : (String(row.lastRunStatus) as "success" | "failure"),
		lastError: row.lastError === null ? null : String(row.lastError),
		createdAt: String(row.createdAt),
	};
}

function rowToCronRun(row: Record<string, unknown>): CronRun {
	return {
		id: String(row.id),
		cronId: String(row.cronId),
		owner: String(row.owner),
		repo: String(row.repo),
		startedAt: String(row.startedAt),
		finishedAt: String(row.finishedAt),
		status: String(row.status) as "success" | "failure",
		output: String(row.output),
		error: row.error === null ? null : String(row.error),
	};
}

export class CronStore {
	private readonly db: DatabaseSync;
	private readonly insertJobStmt: StatementSync;
	private readonly updateJobStmt: StatementSync;
	private readonly deleteJobStmt: StatementSync;
	private readonly insertRunStmt: StatementSync;

	public constructor(dbPath: string) {
		// Ensure parent directory exists
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this._initTables();

		this.insertJobStmt = this.db.prepare(
			`INSERT INTO cron_jobs (id, owner, repo, name, description, prompt, scheduleType, scheduleValue, branch, notificationChannel, enabled, nextRunAt, lastRunAt, lastRunStatus, lastError, createdAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			 owner=excluded.owner, repo=excluded.repo, name=excluded.name, description=excluded.description,
			 prompt=excluded.prompt, scheduleType=excluded.scheduleType, scheduleValue=excluded.scheduleValue,
			 branch=excluded.branch, notificationChannel=excluded.notificationChannel, enabled=excluded.enabled,
			 nextRunAt=excluded.nextRunAt, lastRunAt=excluded.lastRunAt, lastRunStatus=excluded.lastRunStatus,
			 lastError=excluded.lastError, createdAt=excluded.createdAt`,
		);

		this.updateJobStmt = this.db.prepare(
			`UPDATE cron_jobs SET name=?, description=?, prompt=?, scheduleType=?, scheduleValue=?, branch=?, notificationChannel=?, enabled=?, nextRunAt=?, lastRunAt=?, lastRunStatus=?, lastError=? WHERE id=?`,
		);

		this.deleteJobStmt = this.db.prepare("DELETE FROM cron_jobs WHERE owner = ? AND repo = ? AND id = ?");

		this.insertRunStmt = this.db.prepare(
			`INSERT INTO cron_runs (id, cronId, owner, repo, startedAt, finishedAt, status, output, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
	}

	private _initTables(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS cron_jobs (
				id TEXT PRIMARY KEY,
				owner TEXT NOT NULL,
				repo TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL,
				prompt TEXT NOT NULL,
				scheduleType TEXT NOT NULL,
				scheduleValue TEXT NOT NULL,
				branch TEXT NOT NULL,
				notificationChannel TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				nextRunAt TEXT NOT NULL,
				lastRunAt TEXT,
				lastRunStatus TEXT,
				lastError TEXT,
				createdAt TEXT NOT NULL
			)
		`);

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS cron_runs (
				id TEXT PRIMARY KEY,
				cronId TEXT NOT NULL,
				owner TEXT NOT NULL,
				repo TEXT NOT NULL,
				startedAt TEXT NOT NULL,
				finishedAt TEXT NOT NULL,
				status TEXT NOT NULL,
				output TEXT NOT NULL,
				error TEXT
			)
		`);

		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_jobs_owner_repo ON cron_jobs(owner, repo)`);
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(nextRunAt)`);
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_runs_cronId ON cron_runs(cronId)`);
	}

	async get(owner: string, repo: string, id: string): Promise<CronJob | null> {
		const stmt = this.db.prepare("SELECT * FROM cron_jobs WHERE owner = ? AND repo = ? AND id = ?");
		const row = stmt.get(owner, repo, id) as Record<string, unknown> | undefined;
		if (!row) return null;
		return rowToCronJob(row);
	}

	async getAll(): Promise<CronJob[]> {
		const stmt = this.db.prepare("SELECT * FROM cron_jobs ORDER BY createdAt DESC");
		const rows = stmt.all() as Array<Record<string, unknown>>;
		return rows.map(rowToCronJob);
	}

	async listForRepo(owner: string, repo: string): Promise<CronJob[]> {
		const stmt = this.db.prepare("SELECT * FROM cron_jobs WHERE owner = ? AND repo = ? ORDER BY createdAt DESC");
		const rows = stmt.all(owner, repo) as Array<Record<string, unknown>>;
		return rows.map(rowToCronJob);
	}

	async set(job: CronJob): Promise<CronJob> {
		this.insertJobStmt.run(
			job.id,
			job.owner,
			job.repo,
			job.name,
			job.description,
			job.prompt,
			job.scheduleType,
			job.scheduleValue,
			job.branch,
			job.notificationChannel,
			job.enabled ? 1 : 0,
			job.nextRunAt,
			job.lastRunAt,
			job.lastRunStatus,
			job.lastError,
			job.createdAt,
		);
		return job;
	}

	async delete(owner: string, repo: string, id: string): Promise<void> {
		this.deleteJobStmt.run(owner, repo, id);
		// Also delete runs for this cron
		const delRuns = this.db.prepare("DELETE FROM cron_runs WHERE owner = ? AND repo = ? AND cronId = ?");
		delRuns.run(owner, repo, id);
	}

	async createJob(
		owner: string,
		repo: string,
		name: string,
		description: string,
		prompt: string,
		scheduleType: CronScheduleType,
		scheduleValue: string,
		branch: string,
		notificationChannel: string | null,
	): Promise<CronJob> {
		const id = randomUUID();
		const now = new Date().toISOString();
		const nextRunAt = computeNextRunAt(scheduleType, scheduleValue);
		const job: CronJob = {
			id,
			owner,
			repo,
			name,
			description,
			prompt,
			scheduleType,
			scheduleValue,
			branch: branch || "main",
			notificationChannel,
			enabled: true,
			nextRunAt,
			lastRunAt: null,
			lastRunStatus: null,
			lastError: null,
			createdAt: now,
		};
		return this.set(job);
	}

	async addRun(run: CronRun): Promise<void> {
		this.insertRunStmt.run(
			run.id,
			run.cronId,
			run.owner,
			run.repo,
			run.startedAt,
			run.finishedAt,
			run.status,
			run.output,
			run.error,
		);
	}

	async getRuns(owner: string, repo: string, cronId: string, limit = 50): Promise<CronRun[]> {
		const stmt = this.db.prepare(
			"SELECT * FROM cron_runs WHERE owner = ? AND repo = ? AND cronId = ? ORDER BY startedAt DESC LIMIT ?",
		);
		const rows = stmt.all(owner, repo, cronId, limit) as Array<Record<string, unknown>>;
		return rows.map(rowToCronRun);
	}
}
