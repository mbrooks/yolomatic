import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
		// custom: treat as "every N hours" if it matches interval format,
		// otherwise default to daily at the specified time
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

export class CronStore {
	private readonly jobs = new Map<string, CronJob>();
	private readonly runs = new Map<string, CronRun[]>();

	public constructor(
		private readonly cronsDir: string,
		private readonly runsDir: string,
	) {}

	private getJobDir(owner: string, repo: string): string {
		return path.join(this.cronsDir, `${owner}-${repo}`);
	}

	private getJobPath(owner: string, repo: string, id: string): string {
		return path.join(this.getJobDir(owner, repo), `${id}.json`);
	}

	private getRunsPath(owner: string, repo: string, cronId: string): string {
		return path.join(this.runsDir, `${owner}-${repo}`, `${cronId}.jsonl`);
	}

	async get(owner: string, repo: string, id: string): Promise<CronJob | null> {
		const key = `${owner}/${repo}#${id}`;
		const cached = this.jobs.get(key);
		if (cached) {
			return cached;
		}

		const jobPath = this.getJobPath(owner, repo, id);
		try {
			const raw = await readFile(jobPath, "utf8");
			const parsed = JSON.parse(raw) as CronJob;
			this.jobs.set(key, parsed);
			return parsed;
		} catch {
			return null;
		}
	}

	async getAll(): Promise<CronJob[]> {
		const jobs: CronJob[] = [];
		try {
			const entries = await readdir(this.cronsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const repoDir = path.join(this.cronsDir, entry.name);
				const files = await readdir(repoDir);
				for (const file of files) {
					if (!file.endsWith(".json")) continue;
					const filePath = path.join(repoDir, file);
					try {
						const raw = await readFile(filePath, "utf8");
						const parsed = JSON.parse(raw) as CronJob;
						jobs.push(parsed);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						process.stdout.write(`[cron-store] warning: invalid job file ${filePath}: ${message}\n`);
					}
				}
			}
		} catch {
			// crons dir doesn't exist or isn't readable
		}
		return jobs;
	}

	async listForRepo(owner: string, repo: string): Promise<CronJob[]> {
		const jobs: CronJob[] = [];
		try {
			const repoDir = this.getJobDir(owner, repo);
			const files = await readdir(repoDir);
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const filePath = path.join(repoDir, file);
				try {
					const raw = await readFile(filePath, "utf8");
					const parsed = JSON.parse(raw) as CronJob;
					jobs.push(parsed);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[cron-store] warning: invalid job file ${filePath}: ${message}\n`);
				}
			}
		} catch {
			// repo dir doesn't exist
		}
		return jobs;
	}

	async set(job: CronJob): Promise<CronJob> {
		const jobPath = this.getJobPath(job.owner, job.repo, job.id);
		await mkdir(path.dirname(jobPath), { recursive: true });
		const key = `${job.owner}/${job.repo}#${job.id}`;
		this.jobs.set(key, job);
		await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
		return job;
	}

	async delete(owner: string, repo: string, id: string): Promise<void> {
		const key = `${owner}/${repo}#${id}`;
		this.jobs.delete(key);
		const jobPath = this.getJobPath(owner, repo, id);
		try {
			await rm(jobPath, { force: true });
		} catch {
			// ignore
		}
		const runsPath = this.getRunsPath(owner, repo, id);
		try {
			await rm(runsPath, { force: true });
		} catch {
			// ignore
		}
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
		const runsPath = this.getRunsPath(run.owner, run.repo, run.cronId);
		await mkdir(path.dirname(runsPath), { recursive: true });
		const line = `${JSON.stringify(run)}\n`;
		await writeFile(runsPath, line, { flag: "a" });
		const key = `${run.owner}/${run.repo}#${run.cronId}`;
		const existing = this.runs.get(key) ?? [];
		existing.push(run);
		this.runs.set(key, existing);
	}

	async getRuns(owner: string, repo: string, cronId: string, limit = 50): Promise<CronRun[]> {
		const key = `${owner}/${repo}#${cronId}`;
		const cached = this.runs.get(key);
		if (cached) {
			return cached.slice(-limit);
		}

		const runs: CronRun[] = [];
		const runsPath = this.getRunsPath(owner, repo, cronId);
		try {
			const raw = await readFile(runsPath, "utf8");
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line) as CronRun;
					runs.push(parsed);
				} catch {
					// skip invalid line
				}
			}
		} catch {
			// no runs file yet
		}
		this.runs.set(key, runs);
		return runs.slice(-limit);
	}
}
