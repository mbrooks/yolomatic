export class TimeoutError extends Error {
	constructor(
		public readonly elapsedMs: number,
		public readonly limitMs: number,
	) {
		super(`⏱️ Session timed out after ${Math.round(elapsedMs / 60000)} minutes`);
		this.name = "TimeoutError";
	}
}

interface WarningThreshold {
	fraction: number;
	message: string;
}

const WARNING_THRESHOLDS: WarningThreshold[] = [
	{ fraction: 0.5, message: "⏳ Half of session budget used." },
	{ fraction: 0.75, message: "⏳ 25% budget remaining — focusing on essentials." },
	{ fraction: 0.9, message: "⏳ 10% budget remaining — attempting to wrap up cleanly." },
];

export const MIN_TIMEOUT_MINUTES = 5;
export const MAX_TIMEOUT_MINUTES = 60;
export const DEFAULT_TIMEOUT_MINUTES = 30;

export class SessionTimer {
	private startTime: number | undefined = undefined;
	private readonly _limitMs: number;
	private warned = new Set<number>();
	private readonly getNow: () => number;

	constructor(timeoutMinutes: number, getNow?: () => number) {
		this._limitMs = this.clampTimeout(timeoutMinutes) * 60 * 1000;
		this.getNow = getNow ?? Date.now;
	}

	private clampTimeout(value: number): number {
		if (!Number.isFinite(value)) {
			process.stderr.write(`[timer] Invalid timeout value ${value}, using default ${DEFAULT_TIMEOUT_MINUTES} minutes.\n`);
			return DEFAULT_TIMEOUT_MINUTES;
		}
		if (value < MIN_TIMEOUT_MINUTES) {
			process.stderr.write(`[timer] Requested timeout ${value} minutes is below minimum ${MIN_TIMEOUT_MINUTES}, clamped.\n`);
			return MIN_TIMEOUT_MINUTES;
		}
		if (value > MAX_TIMEOUT_MINUTES) {
			process.stderr.write(`[timer] Requested timeout ${value} minutes exceeds maximum ${MAX_TIMEOUT_MINUTES}, clamped.\n`);
			return MAX_TIMEOUT_MINUTES;
		}
		return value;
	}

	start(): void {
		this.startTime = this.getNow();
	}

	elapsedMs(): number {
		if (this.startTime === undefined) return 0;
		return this.getNow() - this.startTime;
	}

	remainingMs(): number {
		return Math.max(0, this._limitMs - this.elapsedMs());
	}

	budgetUsedFraction(): number {
		if (this._limitMs <= 0) return 0;
		return Math.min(1, this.elapsedMs() / this._limitMs);
	}

	isExpired(): boolean {
		return this.elapsedMs() >= this._limitMs;
	}

	check(): { status: "ok" | "warning" | "expired"; warnings: string[] } {
		if (this.isExpired()) return { status: "expired", warnings: [] };
		const warnings = this.consumeWarnings();
		return { status: warnings.length > 0 ? "warning" : "ok", warnings };
	}

	consumeWarnings(): string[] {
		const fraction = this.budgetUsedFraction();
		const warnings: string[] = [];
		for (const threshold of WARNING_THRESHOLDS) {
			if (fraction >= threshold.fraction && !this.warned.has(threshold.fraction)) {
				this.warned.add(threshold.fraction);
				warnings.push(threshold.message);
			}
		}
		return warnings;
	}

	get limitMs(): number {
		return this._limitMs;
	}

	get limitMinutes(): number {
		return this._limitMs / 60000;
	}
}
