import { useEffect, useRef, useState } from "react";
import { fetchStatus } from "../api/status.js";
import { webSocketManager } from "../api/websocket.js";
import type { StatusResponse } from "../app/types.js";

export type ServerState =
	| { status: "loading"; data: null; error: null; updatedAt: null }
	| { status: "ready"; data: StatusResponse; error: null; updatedAt: Date }
	| { status: "error"; data: null; error: string; updatedAt: null };

const initialState: ServerState = { status: "loading", data: null, error: null, updatedAt: null };

export function useServerState(refreshToken = 0): ServerState {
	const [state, setState] = useState<ServerState>(initialState);
	const wsReceivedRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		wsReceivedRef.current = false;

		async function load(): Promise<void> {
			if (wsReceivedRef.current) return;
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

		const unsubscribeConnection = webSocketManager.onStatusChange((status) => {
			if (status !== "open") {
				wsReceivedRef.current = false;
			}
		});

		const unsubscribe = webSocketManager.subscribeStatus((data) => {
			if (cancelled) return;
			wsReceivedRef.current = true;
			setState({ status: "ready", data: data as StatusResponse, error: null, updatedAt: new Date() });
		});

		// Fallback polling when websocket is not connected
		const interval = window.setInterval(() => {
			if (!wsReceivedRef.current) {
				void load();
			}
		}, 5000);

		return () => {
			cancelled = true;
			unsubscribeConnection();
			unsubscribe();
			window.clearInterval(interval);
		};
	}, [refreshToken]);

	return state;
}
