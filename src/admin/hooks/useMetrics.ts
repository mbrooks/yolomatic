import { useEffect, useState } from "react";
import { fetchMetrics } from "../api/metrics.js";
import type { MetricsResponse } from "../app/types.js";

export type MetricsState =
	| { status: "loading"; data: null; error: null }
	| { status: "ready"; data: MetricsResponse; error: null }
	| { status: "error"; data: null; error: string };

const initialState: MetricsState = { status: "loading", data: null, error: null };

/**
 * Loads the persisted dashboard metrics for the requested window (default
 * 7 days) and refreshes on an interval so newly completed sessions appear
 * without a page reload. The dashboard re-renders this hook on its existing
 * refresh tick by passing `refreshToken`.
 */
export function useMetrics(refreshToken = 0, days?: number): MetricsState {
	const [state, setState] = useState<MetricsState>(initialState);

	useEffect(() => {
		let cancelled = false;

		async function load(): Promise<void> {
			try {
				const data = await fetchMetrics(days);
				if (!cancelled) {
					setState({ status: "ready", data, error: null });
				}
			} catch (error) {
				if (!cancelled) {
					const message = error instanceof Error ? error.message : String(error);
					setState({ status: "error", data: null, error: message });
				}
			}
		}

		void load();

		// Poll for newly completed sessions. The metrics endpoint is cheap
		// (a single ranged SQLite scan), so a 30s cadence keeps the graphs
		// fresh without hammering the database.
		const interval = window.setInterval(() => {
			if (!cancelled) void load();
		}, 30000);

		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [refreshToken, days]);

	return state;
}