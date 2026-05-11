import { readFile } from "node:fs/promises";
import type { SessionRepository } from "../../ports/session-repository.js";
import { fail, ok, type AppResult } from "../result.js";

export interface SessionLogView {
	available: boolean;
	truncated: boolean;
	totalLines: number;
	lines: string[];
	error?: string;
}

export class GetSessionLog {
	constructor(private readonly sessions: SessionRepository) {}

	async execute(owner: string, repo: string, issueNumber: number): Promise<AppResult<SessionLogView>> {
		const session = await this.sessions.get(owner, repo, issueNumber);
		if (!session) {
			return fail("not_found", "Session not found");
		}

		if (!session.sessionPath) {
			return ok({ available: false, truncated: false, totalLines: 0, lines: [], error: "No session log path configured" });
		}

		let raw: string;
		try {
			raw = await readFile(session.sessionPath, "utf8");
		} catch {
			return ok({ available: false, truncated: false, totalLines: 0, lines: [], error: "Log file not found" });
		}

		const allLines = raw.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
		const MAX_LINES = 10_000;
		const truncated = allLines.length > MAX_LINES;
		const lines = truncated ? allLines.slice(allLines.length - MAX_LINES) : allLines;

		return ok({ available: true, truncated, totalLines: allLines.length, lines });
	}
}
