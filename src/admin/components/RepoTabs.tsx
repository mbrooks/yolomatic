import React from "react";

export function RepoTabs({
	activeTab,
	onSelectTab,
	onNewIssue,
}: {
	activeTab: "sessions" | "crons";
	onSelectTab: (tab: "sessions" | "crons") => void;
	onNewIssue?: () => void;
}): React.ReactElement {
	return (
		<div className="repo-tabs">
			<button
				className={`repo-tab${activeTab === "sessions" ? " active" : ""}`}
				onClick={() => onSelectTab("sessions")}
				type="button"
			>
				Sessions
			</button>
			<button
				className={`repo-tab${activeTab === "crons" ? " active" : ""}`}
				onClick={() => onSelectTab("crons")}
				type="button"
			>
				Crons
			</button>
			{onNewIssue ? (
				<button className="repo-tab new-issue" onClick={onNewIssue} type="button">
					+ New Issue
				</button>
			) : null}
		</div>
	);
}
