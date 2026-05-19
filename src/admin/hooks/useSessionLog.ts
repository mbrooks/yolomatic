import { useEffect, useRef, useState } from "react";
import { fetchSessionLog } from "../api/sessions.js";
import type { LogEntry, Session } from "../app/types.js";

export type LogLoadState = {
	status: "idle" | "loading" | "ready" | "error";
	logs: LogEntry[];
	error: string | null;
	refreshing: boolean;
};

export function useSessionLog(session: Session | null, paused = false): LogLoadState {
	const [state, setState] = useState<LogLoadState>({
		status: "idle",
		logs: [],
		error: null,
		refreshing: false,
	});
	const sinceRef = useRef<string | undefined>(undefined);
	const pausedRef = useRef(paused);
	pausedRef.current = paused;
	const sessionKey = session ? `${session.owner}/${session.repo}#${session.issueNumber}` : null;
	const prevSessionKeyRef = useRef<string | null>(null);

	useEffect(() => {
		const keyChanged = sessionKey !== prevSessionKeyRef.current;
		if (keyChanged) {
			prevSessionKeyRef.current = sessionKey;
			sinceRef.current = undefined;
			setState({ status: "idle", logs: [], error: null, refreshing: false });
		}
		if (!session) {
			return;
		}

		const { owner, repo, issueNumber, status } = session;
		let cancelled = false;

		async function load(): Promise<void> {
			if (pausedRef.current) return;
			setState((current) => {
				if (current.logs.length > 0) {
					return { ...current, error: null, refreshing: true };
				}
				return { status: "loading", logs: [], error: null, refreshing: false };
			});
			try {
				const data = await fetchSessionLog(owner, repo, issueNumber, sinceRef.current);
				if (!cancelled) {
					if (data.available && data.logs.length > 0) {
						sinceRef.current = data.logs[data.logs.length - 1].timestamp;
						setState((current) => ({
							status: "ready",
							logs: [...current.logs, ...data.logs],
							error: null,
							refreshing: false,
						}));
					} else {
						setState((current) => ({
							status: "ready",
							logs: current.logs,
							error: null,
							refreshing: false,
						}));
					}
				}
			} catch (error) {
				if (!cancelled) {
					const message = error instanceof Error ? error.message : String(error);
					setState((current) => ({
						status: current.logs.length > 0 ? "ready" : "error",
						logs: current.logs,
						error: message,
						refreshing: false,
					}));
				}
			}
		}

		void load();

		if (status === "complete") {
			return () => {
				cancelled = true;
			};
		}

		const interval = window.setInterval(() => void load(), 2500);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [sessionKey, session?.status]);

	return state;
}
