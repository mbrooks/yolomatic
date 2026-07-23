#!/usr/bin/env node

import "dotenv/config";

import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const memoryDir = path.resolve(process.env.MEMORY_DIR?.trim() || path.join(process.cwd(), "memory"));
const dbPath = path.resolve(process.argv[2]?.trim() || path.join(memoryDir, "bot-state.sqlite"));

if (!existsSync(dbPath)) {
	process.stderr.write(`Settings database not found: ${dbPath}\n`);
	process.exitCode = 1;
} else {
	const db = new DatabaseSync(dbPath);
	try {
		db.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		).run("onboarding_complete", "false", new Date().toISOString());
		process.stdout.write(`Onboarding reset in ${dbPath}. Refresh /tarsadmin to run the wizard.\n`);
	} finally {
		db.close();
	}
}
