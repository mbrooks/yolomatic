import React from "react";
import { Breadcrumb } from "./Breadcrumb.js";
import { EmptyState } from "./EmptyState.js";
import { RepoTabs } from "./RepoTabs.js";

export type RepoScopedTab = "sessions" | "skills" | "issues";

export function RepoScopedScreenShell({
	owner,
	repo,
	activeTab,
	onSelectTab,
	onBack,
	loading,
	loadingMessage,
	empty,
	emptyMessage,
	emptyAction,
	children,
}: {
	owner: string;
	repo: string;
	activeTab: RepoScopedTab;
	onSelectTab: (tab: RepoScopedTab) => void;
	onBack: () => void;
	loading: boolean;
	loadingMessage: string;
	empty: boolean;
	emptyMessage: string;
	emptyAction?: React.ReactNode;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<>
			<RepoTabs activeTab={activeTab} onSelectTab={onSelectTab} />
			<Breadcrumb label={`${owner}/${repo}`} onBack={onBack} />
			{loading && empty ? (
				<div className="empty">{loadingMessage}</div>
			) : empty ? (
				<EmptyState message={emptyMessage}>{emptyAction}</EmptyState>
			) : (
				<div className="workspace">{children}</div>
			)}
		</>
	);
}
