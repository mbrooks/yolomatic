import React, { useEffect, useRef, useState } from "react";
import { useSessionLog } from "../../hooks/useSessionLog.js";

export function SessionLogPanel({
	state,
	paused,
	onPauseToggle,
	suppressRefreshNotice = false,
}: {
	state: ReturnType<typeof useSessionLog>;
	paused: boolean;
	onPauseToggle: () => void;
	suppressRefreshNotice?: boolean;
}): React.ReactElement {
	const [autoScroll, setAutoScroll] = useState(true);
	const logFeedRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (autoScroll && logFeedRef.current && state.logs.length > 0) {
			logFeedRef.current.scrollTop = logFeedRef.current.scrollHeight;
		}
	}, [state.logs, autoScroll]);

	if (state.status === "idle") {
		return <div className="log-status">Select a session to load logs.</div>;
	}

	if (state.status === "loading") {
		return <div className="log-status">Loading log…</div>;
	}

	if (state.status === "error" && state.logs.length === 0) {
		return <div className="log-status log-error">{state.error ?? "Unable to load log."}</div>;
	}

	return (
		<>
			<div className="log-controls">
				<label>
					<input
						type="checkbox"
						checked={autoScroll}
						onChange={(e) => setAutoScroll(e.target.checked)}
					/>{" "}
					Auto-scroll
				</label>
				<button type="button" onClick={onPauseToggle}>
					{paused ? "Resume" : "Pause"}
				</button>
			</div>
			<div ref={logFeedRef} className="log-feed">
				{state.logs.length === 0 ? (
					<div style={{ color: "#8b949e" }}>No logs</div>
				) : (
					state.logs.map((entry) => {
						const ts = entry.timestamp.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
						return (
							<div
								key={`${entry.timestamp}-${entry.level}-${entry.message.slice(0, 20)}`}
								className="log-entry"
							>
								<span className="log-ts">{ts} </span>
								<span className={`log-level-${entry.level}`}>[{entry.level.toUpperCase()}]</span>{" "}
								{entry.message}
							</div>
						);
					})
				)}
			</div>
			{state.refreshing && !suppressRefreshNotice ? <div className="log-refresh-notice">Refreshing…</div> : null}
		</>
	);
}
