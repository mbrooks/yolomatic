import React from "react";

export function RepoTabs({
	activeTab,
	onSelectTab,
	onNewIssue,
}: {
	activeTab: "sessions" | "crons" | "skills" | "issues";
	onSelectTab: (tab: "sessions" | "crons" | "skills" | "issues") => void;
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
			<button
				className={`repo-tab${activeTab === "skills" ? " active" : ""}`}
				onClick={() => onSelectTab("skills")}
				type="button"
			>
				Skills
			</button>
			<button
				className={`repo-tab${activeTab === "issues" ? " active" : ""}`}
				onClick={() => onSelectTab("issues")}
				type="button"
			>
				Issues
			</button>
			{onNewIssue ? (
				<button className="repo-tab new-issue" onClick={onNewIssue} type="button">
					+ New Issue
				</button>
			) : null}
		</div>
	);
}
