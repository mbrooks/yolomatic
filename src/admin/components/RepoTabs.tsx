import React from "react";

export function RepoTabs({
	activeTab,
	onSelectTab,
}: {
	activeTab: "sessions" | "skills" | "issues";
	onSelectTab: (tab: "sessions" | "skills" | "issues") => void;
}): React.ReactElement {
	return (
		<div className="repo-tabs">
			<button
				className={`repo-tab${activeTab === "issues" ? " active" : ""}`}
				onClick={() => onSelectTab("issues")}
				type="button"
			>
				Issues
			</button>
			<button
				className={`repo-tab${activeTab === "sessions" ? " active" : ""}`}
				onClick={() => onSelectTab("sessions")}
				type="button"
			>
				Sessions
			</button>
			<button
				className={`repo-tab${activeTab === "skills" ? " active" : ""}`}
				onClick={() => onSelectTab("skills")}
				type="button"
			>
				Skills
			</button>
		</div>
	);
}
