import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../migrations/index.js";

export interface User {
	id: string;
	fullName: string;
	username: string;
	passwordHash: string;
	createdAt: string;
	updatedAt: string;
}

export interface UserInput {
	fullName: string;
	username: string;
	password: string;
}

export interface UserView {
	id: string;
	fullName: string;
	username: string;
	createdAt: string;
	updatedAt: string;
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

function toUserView(user: User): UserView {
	return {
		id: user.id,
		fullName: user.fullName,
		username: user.username,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
	};
}

function rowToUser(row: Record<string, unknown>): User {
	return {
		id: String(row.id),
		fullName: String(row.full_name),
		username: String(row.username),
		passwordHash: String(row.password_hash),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

/**
 * Hash a plaintext password with scrypt. The returned string embeds the salt
 * and scrypt parameters so it can be verified later without external state.
 * Plaintext passwords are never stored or logged.
 */
export function hashPassword(password: string): string {
	const salt = randomBytes(SALT_LEN);
	const hash = scryptSync(password, salt, KEY_LEN, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
	});
	return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored scrypt hash. Constant-time over
 * the hash bytes to avoid leaking information about partial matches.
 */
export function verifyPassword(password: string, stored: string): boolean {
	const parts = stored.split(":");
	if (parts.length !== 6 || parts[0] !== "scrypt") {
		return false;
	}
	const N = Number.parseInt(parts[1], 10);
	const r = Number.parseInt(parts[2], 10);
	const p = Number.parseInt(parts[3], 10);
	const salt = Buffer.from(parts[4], "hex");
	const expected = Buffer.from(parts[5], "hex");
	if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || salt.length === 0) {
		return false;
	}
	const computed = scryptSync(password, salt, expected.length, { N, r, p });
	if (computed.length !== expected.length) {
		return false;
	}
	return timingSafeEqual(computed, expected);
}

export class UserStore {
	private readonly db: DatabaseSync;
	private readonly insertStmt: StatementSync;
	private readonly getByIdStmt: StatementSync;
	private readonly getByUsernameStmt: StatementSync;
	private readonly listStmt: StatementSync;
	private readonly deleteStmt: StatementSync;
	private readonly updateFullNameStmt: StatementSync;
	private readonly updatePasswordStmt: StatementSync;
	private readonly countStmt: StatementSync;
	private readonly firstStmt: StatementSync;

	public constructor(dbPath: string) {
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		runMigrations(this.db);

		this.insertStmt = this.db.prepare(
			`INSERT INTO users (id, full_name, username, password_hash, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		this.getByIdStmt = this.db.prepare("SELECT * FROM users WHERE id = ?");
		this.getByUsernameStmt = this.db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE");
		this.listStmt = this.db.prepare("SELECT * FROM users ORDER BY created_at ASC, username ASC");
		this.deleteStmt = this.db.prepare("DELETE FROM users WHERE id = ?");
		this.updateFullNameStmt = this.db.prepare(
			"UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?",
		);
		this.updatePasswordStmt = this.db.prepare(
			"UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
		);
		this.countStmt = this.db.prepare("SELECT COUNT(*) as count FROM users");
		this.firstStmt = this.db.prepare("SELECT * FROM users ORDER BY created_at ASC LIMIT 1");
	}

	async create(input: UserInput): Promise<User> {
		return this.createSync(input);
	}

	createSync(input: UserInput): User {
		const fullName = input.fullName.trim();
		const username = input.username.trim();
		if (!fullName) {
			throw new Error("full_name is required");
		}
		if (!username) {
			throw new Error("username is required");
		}
		if (!input.password) {
			throw new Error("password is required");
		}
		const existing = this.getByUsernameSync(username);
		if (existing) {
			throw new Error(`Username '${username}' is already taken`);
		}
		const now = new Date().toISOString();
		const user: User = {
			id: randomUUID(),
			fullName,
			username,
			passwordHash: hashPassword(input.password),
			createdAt: now,
			updatedAt: now,
		};
		this.insertStmt.run(
			user.id,
			user.fullName,
			user.username,
			user.passwordHash,
			user.createdAt,
			user.updatedAt,
		);
		return user;
	}

	async getById(id: string): Promise<User | null> {
		return this.getByIdSync(id);
	}

	getByIdSync(id: string): User | null {
		const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
		return row ? rowToUser(row) : null;
	}

	async getByUsername(username: string): Promise<User | null> {
		return this.getByUsernameSync(username);
	}

	getByUsernameSync(username: string): User | null {
		const row = this.getByUsernameStmt.get(username.trim()) as Record<string, unknown> | undefined;
		return row ? rowToUser(row) : null;
	}

	async list(): Promise<User[]> {
		return this.listSync();
	}

	listSync(): User[] {
		const rows = this.listStmt.all() as Array<Record<string, unknown>>;
		return rows.map(rowToUser);
	}

	listViews(): UserView[] {
		return this.listSync().map(toUserView);
	}

	async delete(id: string): Promise<boolean> {
		return this.deleteSync(id);
	}

	deleteSync(id: string): boolean {
		const existing = this.getByIdSync(id);
		if (!existing) return false;
		this.deleteStmt.run(id);
		return true;
	}

	async updateFullName(id: string, fullName: string): Promise<User | null> {
		return this.updateFullNameSync(id, fullName);
	}

	updateFullNameSync(id: string, fullName: string): User | null {
		const existing = this.getByIdSync(id);
		if (!existing) return null;
		const trimmed = fullName.trim();
		if (!trimmed) {
			throw new Error("full_name is required");
		}
		this.updateFullNameStmt.run(trimmed, new Date().toISOString(), id);
		return this.getByIdSync(id);
	}

	async updatePassword(id: string, password: string): Promise<User | null> {
		return this.updatePasswordSync(id, password);
	}

	updatePasswordSync(id: string, password: string): User | null {
		const existing = this.getByIdSync(id);
		if (!existing) return null;
		if (!password) {
			throw new Error("password is required");
		}
		this.updatePasswordStmt.run(hashPassword(password), new Date().toISOString(), id);
		return this.getByIdSync(id);
	}

	async hasAny(): Promise<boolean> {
		return this.hasAnySync();
	}

	hasAnySync(): boolean {
		const row = this.countStmt.get() as { count: number } | undefined;
		return (row?.count ?? 0) > 0;
	}

	async first(): Promise<User | null> {
		return this.firstSync();
	}

	firstSync(): User | null {
		const row = this.firstStmt.get() as Record<string, unknown> | undefined;
		return row ? rowToUser(row) : null;
	}

	close(): void {
		this.db.close();
	}
}