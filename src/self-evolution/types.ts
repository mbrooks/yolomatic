export type RootCauseLevel = "prompt-level" | "code-level" | "config-level";

export interface RootCauseAnalysis {
	level: RootCauseLevel;
	description: string;
	affectedFiles: string[];
}

export interface Patch {
	filePath: string;
	originalContent: string;
	patchedContent: string;
	diff: string;
}

export interface RollbackSnapshot {
	timestamp: string;
	backups: Record<string, string>;
}

export interface ValidationResult {
	ok: boolean;
	output: string;
}
