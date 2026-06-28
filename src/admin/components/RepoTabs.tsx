import React from "react";

export function RepoTabs({
	activeTab,
	onSelectTab,
}: {
	activeTab: "sessions" | "skills" | "issues" | "settings";
	onSelectTab: (tab: "sessions" | "skills" | "issues" | "settings") => void;
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
				className={`repo-tab${activeTab === "issues" ? " active" : ""}`}
				onClick={() => onSelectTab("issues")}
				type="button"
			>
				Issues
			</button>
			<button
				className={`repo-tab${activeTab === "skills" ? " active" : ""}`}
				onClick={() => onSelectTab("skills")}
				type="button"
			>
				Skills
			</button>
			<button
				className={`repo-tab${activeTab === "settings" ? " active" : ""}`}
				onClick={() => onSelectTab("settings")}
				type="button"
			>
				Settings
			</button>
		</div>
	);
}
