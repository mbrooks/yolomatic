import { useEffect, useState } from "react";
import { fetchSessionLog } from "../api/sessions.js";
import type { Session, SessionLogResponse } from "../app/types.js";

export type LogLoadState = {
	status: "idle" | "loading" | "ready" | "error";
	data: SessionLogResponse | null;
	error: string | null;
	refreshing: boolean;
};

export function useSessionLog(session: Session | null): LogLoadState {
	const [state, setState] = useState<LogLoadState>({
		status: "idle",
		data: null,
		error: null,
		refreshing: false,
	});
	const sessionKey = session ? `${session.owner}/${session.repo}#${session.issueNumber}` : null;

	useEffect(() => {
		if (!session) {
			setState({ status: "idle", data: null, error: null, refreshing: false });
			return;
		}

		const { owner, repo, issueNumber, status } = session;
		let cancelled = false;

		async function load(): Promise<void> {
			setState((current) => {
				if (current.data) {
					return { ...current, error: null, refreshing: true };
				}
				return { status: "loading", data: null, error: null, refreshing: false };
			});
			try {
				const data = await fetchSessionLog(owner, repo, issueNumber);
				if (!cancelled) {
					setState({ status: "ready", data, error: null, refreshing: false });
				}
			} catch (error) {
				if (!cancelled) {
					const message = error instanceof Error ? error.message : String(error);
					setState((current) => {
						if (current.data) {
							return { ...current, error: message, refreshing: false };
						}
						return { status: "error", data: null, error: message, refreshing: false };
					});
				}
			}
		}

		void load();

		if (status === "complete") {
			return () => {
				cancelled = true;
			};
		}

		const interval = window.setInterval(() => void load(), 5000);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [sessionKey, session?.status]);

	return state;
}
