import { apiGet } from "./client.js";
import type { RefinementAttemptsResponse, RefinementLogResponse } from "../app/types.js";

export function fetchRefinementLog(
	owner: string,
	repo: string,
	issueNumber: number,
	since?: string,
): Promise<RefinementLogResponse> {
	const qs = since ? `?since=${encodeURIComponent(since)}` : "";
	return apiGet<RefinementLogResponse>(
		`/api/refinements/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/log${qs}`,
	);
}

export function fetchRefinementAttempts(
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<RefinementAttemptsResponse> {
	return apiGet<RefinementAttemptsResponse>(
		`/api/refinements/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/attempts`,
	);
}