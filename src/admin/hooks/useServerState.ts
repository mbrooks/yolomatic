import { useEffect, useState } from "react";
import { fetchStatus } from "../api/status.js";
import type { StatusResponse } from "../app/types.js";

export type ServerState =
	| { status: "loading"; data: null; error: null; updatedAt: null }
	| { status: "ready"; data: StatusResponse; error: null; updatedAt: Date }
	| { status: "error"; data: null; error: string; updatedAt: null };

const initialState: ServerState = { status: "loading", data: null, error: null, updatedAt: null };

export function useServerState(refreshToken = 0): ServerState {
	const [state, setState] = useState<ServerState>(initialState);

	useEffect(() => {
		let cancelled = false;

		async function load(): Promise<void> {
			try {
				const data = await fetchStatus();
				if (!cancelled) {
					setState({ status: "ready", data, error: null, updatedAt: new Date() });
				}
			} catch (error) {
				if (!cancelled) {
					const message = error instanceof Error ? error.message : String(error);
					setState({ status: "error", data: null, error: message, updatedAt: null });
				}
			}
		}

		void load();
		const interval = window.setInterval(() => void load(), 5000);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [refreshToken]);

	return state;
}
