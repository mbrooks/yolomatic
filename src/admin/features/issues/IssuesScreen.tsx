import React, { useState } from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { EmptyState } from "../../components/EmptyState.js";
import { RepoTabs } from "../../components/RepoTabs.js";
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

	return (
		<>
			<RepoTabs activeTab="issues" onSelectTab={onSelectTab} onNewIssue={onNewIssue} />
			<Breadcrumb label={`${owner}/${repo}`} onBack={onBack} />
			{loading ? (
				<div className="empty">Loading issues...</div>
			) : issues.length === 0 ? (
				<EmptyState message="No open issues for this repository." />
			) : (
				<div className="workspace">
					<IssueListPane issues={issues} selected={selected} onSelect={setSelected} />
					<IssueDetail selected={selected} owner={owner} repo={repo} onAssignSuccess={reload} />
				</div>
			)}
		</>
	);
}
