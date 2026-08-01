import { useEffect, useRef, useState } from "react";
import { fetchRefinementAttempts, fetchRefinementLog } from "../api/refinements.js";
import { webSocketManager } from "../api/websocket.js";
import type { LogEntry, RefinementAttempt } from "../app/types.js";

export interface RefinementActivityState {
	status: "idle" | "loading" | "ready" | "error";
	attempts: RefinementAttempt[];
	logs: LogEntry[];
	error: string | null;
	refreshing: boolean;
}

export type RefinementActivityKey = string | null;

function keyFor(owner: string, repo: string, issueNumber: number): string {
	return `${owner}/${repo}#${issueNumber}`;
}

/**
 * Loads durable issue-refinement activity (attempts + activity log) for an
 * issue and streams live log entries over the admin WebSocket. Mirrors the
 * coding-task log hook but is gated on refinement attempts rather than an
 * implementation session.
 */
export function useRefinementLog(
	owner: string,
	repo: string,
	issueNumber: number | null,
): RefinementActivityState {
	const [state, setState] = useState<RefinementActivityState>({
		status: "idle",
		attempts: [],
		logs: [],
		error: null,
		refreshing: false,
	});
	const sinceRef = useRef<string | undefined>(undefined);
	const activityKey = issueNumber != null ? keyFor(owner, repo, issueNumber) : null;
	const prevKeyRef = useRef<RefinementActivityKey>(null);
	const wsConnectedRef = useRef(false);

	useEffect(() => {
		const keyChanged = activityKey !== prevKeyRef.current;
		if (keyChanged) {
			prevKeyRef.current = activityKey;
			sinceRef.current = undefined;
			wsConnectedRef.current = false;
			setState({ status: "idle", attempts: [], logs: [], error: null, refreshing: false });
		}
		if (issueNumber == null) {
			return;
		}

		let cancelled = false;

		async function loadAttempts(): Promise<RefinementAttempt[]> {
			try {
				const data = await fetchRefinementAttempts(owner, repo, issueNumber!);
				return data.attempts ?? [];
			} catch (error) {
				if (!cancelled) {
					const message = error instanceof Error ? error.message : String(error);
					setState((current) => ({ ...current, status: "ready", error: message }));
				}
				return [];
			}
		}

		async function loadLogs(initial: boolean): Promise<void> {
			if (initial) {
				setState((current) => {
					if (current.logs.length > 0) {
						return { ...current, refreshing: true };
					}
					return { ...current, status: "loading", logs: [], error: null, refreshing: false };
				});
			}
			try {
				const data = await fetchRefinementLog(owner, repo, issueNumber!, sinceRef.current);
				if (!cancelled) {
					if (data.available && data.logs.length > 0) {
						sinceRef.current = data.logs[data.logs.length - 1].timestamp;
						setState((current) => ({
							...current,
							status: "ready",
							logs: [...current.logs, ...data.logs],
							error: null,
							refreshing: false,
						}));
					} else if (initial) {
						setState((current) => ({ ...current, status: "ready", error: null, refreshing: false }));
					} else {
						setState((current) => ({ ...current, refreshing: false }));
					}
				}
			} catch (error) {
				if (!cancelled) {
					const message = error instanceof Error ? error.message : String(error);
					setState((current) => ({
						...current,
						status: current.logs.length > 0 ? "ready" : "error",
						error: message,
						refreshing: false,
					}));
				}
			}
		}

		async function loadAll(initial: boolean): Promise<void> {
			const [attempts] = await Promise.all([loadAttempts(), loadLogs(initial)]);
			if (!cancelled && attempts.length > 0) {
				setState((current) => ({ ...current, attempts }));
			}
		}

		void loadAll(true);

		const unsubscribeConnection = webSocketManager.onStatusChange((connectionStatus) => {
			if (connectionStatus !== "open") {
				wsConnectedRef.current = false;
			}
		});

		const unsubscribe = webSocketManager.subscribeLog(owner, repo, issueNumber, (entry) => {
			if (cancelled) return;
			wsConnectedRef.current = true;
			sinceRef.current = entry.timestamp;
			setState((current) => ({
				...current,
				status: "ready",
				logs: [...current.logs, entry],
				error: null,
				refreshing: false,
			}));
		});

		const interval = window.setInterval(() => {
			if (!wsConnectedRef.current) {
				void loadAll(false);
			}
		}, 5000);

		return () => {
			cancelled = true;
			unsubscribeConnection();
			unsubscribe();
			window.clearInterval(interval);
		};
	}, [activityKey, owner, repo, issueNumber]);

	return state;
}