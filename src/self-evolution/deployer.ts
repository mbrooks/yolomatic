import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import os from "node:os";
import path from "node:path";
import type { Patch, RollbackSnapshot } from "./types.js";

export class SafeDeployer {
	private readonly backupDir: string;

	constructor(backupDir?: string) {
		this.backupDir = backupDir ?? path.join(os.tmpdir(), "yolomatic-self-evolution-backups");
	}

	async applyPatch(patch: Patch): Promise<RollbackSnapshot> {
		const timestamp = new Date().toISOString();
		const backups: Record<string, string> = {};
		const backupPath = path.join(this.backupDir, `${Date.now()}-${path.basename(patch.filePath)}`);
		await mkdir(dirname(backupPath), { recursive: true });
		await copyFile(patch.filePath, backupPath);
		backups[patch.filePath] = backupPath;
		await writeFile(patch.filePath, patch.patchedContent, "utf-8");
		return { timestamp, backups };
	}

	async rollback(snapshot: RollbackSnapshot): Promise<void> {
		for (const [originalPath, backupPath] of Object.entries(snapshot.backups)) {
			await copyFile(backupPath, originalPath);
		}
	}
}
