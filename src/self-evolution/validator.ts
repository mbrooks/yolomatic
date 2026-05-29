import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ValidationResult } from "./types.js";

const defaultExecFileAsync = promisify(execFile);

export class Validator {
	private readonly execFileAsync: typeof defaultExecFileAsync;

	constructor(execFileAsync?: typeof defaultExecFileAsync) {
		this.execFileAsync = execFileAsync ?? defaultExecFileAsync;
	}

	async validate(testCommand = "npm run guardrail:test", cwd?: string): Promise<ValidationResult> {
		try {
			const { stdout, stderr } = await this.execFileAsync("sh", ["-c", testCommand], { cwd, timeout: 120_000 });
			return { ok: true, output: stdout + stderr };
		} catch (error: any) {
			return { ok: false, output: (error.stdout ?? "") + (error.stderr ?? "") + error.message };
		}
	}
}
