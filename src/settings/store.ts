import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { runMigrations } from "../migrations/index.js";
import {
	getSettingDefinition,
	parseSettingValue,
	formatSettingValue,
	coerceEnvValue,
	SETTING_DEFINITIONS,
} from "./model.js";
import type { SettingEntry, SettingDefinition, SettingView } from "./model.js";

export class SettingsStore {
	private readonly db: DatabaseSync;
	private readonly insertStmt: StatementSync;
	private readonly getStmt: StatementSync;

	public constructor(dbPath: string) {
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		runMigrations(this.db);

		this.getStmt = this.db.prepare("SELECT * FROM settings WHERE key = ?");
		this.insertStmt = this.db.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		);
	}

	get(key: string): string | undefined {
		const row = this.getStmt.get(key) as Record<string, unknown> | undefined;
		if (!row) return undefined;
		return String(row.value);
	}

	getString(key: string, defaultValue?: string): string {
		const value = this.get(key);
		if (value !== undefined) return value;
		if (defaultValue !== undefined) return defaultValue;
		const def = getSettingDefinition(key);
		if (def?.default !== undefined) return def.default;
		throw new Error(`Setting ${key} is required`);
	}

	getNumber(key: string, defaultValue?: number): number {
		const raw = this.get(key);
		if (raw !== undefined) {
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isNaN(parsed)) return parsed;
		}
		if (defaultValue !== undefined) return defaultValue;
		const def = getSettingDefinition(key);
		if (def?.default !== undefined) return Number.parseInt(def.default, 10);
		throw new Error(`Setting ${key} is required`);
	}

	getBoolean(key: string, defaultValue?: boolean): boolean {
		const raw = this.get(key);
		if (raw !== undefined) return raw === "true";
		if (defaultValue !== undefined) return defaultValue;
		const def = getSettingDefinition(key);
		if (def?.default !== undefined) return def.default === "true";
		return false;
	}

	set(key: string, value: string): void {
		const def = getSettingDefinition(key);
		if (!def) {
			throw new Error(`Unknown setting: ${key}`);
		}
		this.insertStmt.run(key, value, new Date().toISOString());
	}

	setTyped(key: string, value: string | number | boolean): void {
		const def = getSettingDefinition(key);
		if (!def) {
			throw new Error(`Unknown setting: ${key}`);
		}
		const formatted = formatSettingValue(def, value);
		this.insertStmt.run(key, formatted, new Date().toISOString());
	}

	getAll(): SettingEntry[] {
		const stmt = this.db.prepare("SELECT key, value, updated_at FROM settings ORDER BY key");
		const rows = stmt.all() as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			key: String(row.key),
			value: String(row.value),
			updatedAt: String(row.updated_at),
		}));
	}

	getAllViews(): SettingView[] {
		const entries = this.getAll();
		const entryMap = new Map(entries.map((e) => [e.key, e]));
		return SETTING_DEFINITIONS.map((def) => {
			const entry = entryMap.get(def.key);
			let rawValue = entry?.value ?? def.default ?? "";
			if (def.sensitive) {
				rawValue = "";
			}
			return {
				key: def.key,
				value: parseSettingValue(def, rawValue),
				type: def.type,
				description: def.description,
				default: def.default !== undefined ? parseSettingValue(def, def.default) : undefined,
				requiresRestart: def.requiresRestart,
				sensitive: def.sensitive,
				updatedAt: entry?.updatedAt ?? "",
			};
		});
	}

	isEmpty(): boolean {
		const stmt = this.db.prepare("SELECT COUNT(*) as count FROM settings");
		const row = stmt.get() as { count: number } | undefined;
		return (row?.count ?? 0) === 0;
	}

	seedFromEnv(env = process.env): void {
		for (const def of SETTING_DEFINITIONS) {
			const envValue = env[def.envVar]?.trim();
			if (!envValue) continue;
			const coerced = coerceEnvValue(def.key, envValue);
			if (coerced === undefined) continue;
			// Only seed if not already present
			const existing = this.get(def.key);
			if (existing === undefined) {
				this.set(def.key, coerced);
			}
		}
	}

	applyDefaults(): void {
		for (const def of SETTING_DEFINITIONS) {
			if (def.default === undefined) continue;
			const existing = this.get(def.key);
			if (existing === undefined) {
				this.set(def.key, def.default);
			}
		}
	}
}
