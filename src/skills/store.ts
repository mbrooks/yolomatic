import { DatabaseSync, type StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { runMigrations } from "../migrations/index.js";
import type { ServerSkill } from "./model.js";

function rowToSkill(row: Record<string, unknown>): ServerSkill {
	return {
		id: String(row.id),
		name: String(row.name),
		description: String(row.description),
		content: String(row.content),
		updatedAt: String(row.updated_at),
		createdAt: String(row.created_at),
	};
}

export class SkillStore {
	private readonly db: DatabaseSync;
	private readonly insertStmt: StatementSync;
	private readonly deleteStmt: StatementSync;

	public constructor(dbPath: string) {
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		runMigrations(this.db);

		this.insertStmt = this.db.prepare(
			`INSERT INTO skills (id, name, description, content, updated_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			 name=excluded.name, description=excluded.description, content=excluded.content,
			 updated_at=excluded.updated_at`,
		);

		this.deleteStmt = this.db.prepare("DELETE FROM skills WHERE id = ?");
	}

	async get(id: string): Promise<ServerSkill | null> {
		const stmt = this.db.prepare("SELECT * FROM skills WHERE id = ?");
		const row = stmt.get(id) as Record<string, unknown> | undefined;
		if (!row) return null;
		return rowToSkill(row);
	}

	async getByName(name: string): Promise<ServerSkill | null> {
		const stmt = this.db.prepare("SELECT * FROM skills WHERE name = ?");
		const row = stmt.get(name) as Record<string, unknown> | undefined;
		if (!row) return null;
		return rowToSkill(row);
	}

	async listAll(): Promise<ServerSkill[]> {
		const stmt = this.db.prepare("SELECT * FROM skills ORDER BY updated_at DESC, created_at DESC, rowid DESC");
		const rows = stmt.all() as Array<Record<string, unknown>>;
		return rows.map(rowToSkill);
	}

	async create(data: { name: string; description: string; content: string }): Promise<ServerSkill> {
		const now = new Date().toISOString();
		const skill: ServerSkill = {
			id: randomUUID(),
			name: data.name,
			description: data.description,
			content: data.content,
			updatedAt: now,
			createdAt: now,
		};
		this.insertStmt.run(skill.id, skill.name, skill.description, skill.content, skill.updatedAt, skill.createdAt);
		return skill;
	}

	async update(id: string, data: Partial<{ name: string; description: string; content: string }>): Promise<ServerSkill | null> {
		const existing = await this.get(id);
		if (!existing) return null;

		const updated: ServerSkill = {
			...existing,
			name: data.name ?? existing.name,
			description: data.description ?? existing.description,
			content: data.content ?? existing.content,
			updatedAt: new Date().toISOString(),
		};
		this.insertStmt.run(updated.id, updated.name, updated.description, updated.content, updated.updatedAt, updated.createdAt);
		return updated;
	}

	async delete(id: string): Promise<boolean> {
		this.deleteStmt.run(id);
		return true;
	}
}
