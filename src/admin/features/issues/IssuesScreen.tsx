import React, { useState, useEffect } from "react";
import { RepoScopedScreenShell } from "../../components/RepoScopedScreenShell.js";
import type { OpenIssue } from "../../api/issues.js";
import { useRepoIssues } from "./useRepoIssues.js";
import { IssueListPane } from "./IssueListPane.js";
import { IssueDetail } from "./IssueDetail.js";

export function IssuesScreen({
	owner,
	repo,
	onBack,
	onSelectTab,
	onNewIssue,
}: {
	owner: string;
	repo: string;
	onBack: () => void;
	onSelectTab: (tab: "sessions" | "crons" | "skills" | "issues") => void;
	onNewIssue?: () => void;
}): React.ReactElement {
	const { issues, loading, reload } = useRepoIssues(owner, repo);
	const [selected, setSelected] = useState<OpenIssue | null>(null);

	useEffect(() => {
		if (selected) {
			const updated = issues.find((i) => i.number === selected.number);
			if (updated) {
				setSelected(updated);
			}
		}
	}, [issues]);

	return (
		<RepoScopedScreenShell
			owner={owner}
			repo={repo}
			activeTab="issues"
			onSelectTab={onSelectTab}
			onNewIssue={onNewIssue}
			onBack={onBack}
			loading={issues.length === 0 && loading}
			loadingMessage="Loading issues..."
			empty={issues.length === 0}
			emptyMessage="No open issues for this repository."
		>
			<IssueListPane issues={issues} selected={selected} onSelect={setSelected} />
			<IssueDetail
				selected={selected}
				owner={owner}
				repo={repo}
				onAssignSuccess={reload}
				onCloseSuccess={() => {
					setSelected(null);
					reload();
				}}
				onMarkDoNotWorkSuccess={() => {
					setSelected(null);
					reload();
				}}
			/>
		</RepoScopedScreenShell>
	);
}
