import React from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { EmptyState } from "../../components/EmptyState.js";
import { RepoTabs } from "../../components/RepoTabs.js";
import type { Session } from "../../app/types.js";
import { SessionListPane } from "./SessionListPane.js";
import { SessionDetail } from "./SessionDetail.js";

export function SessionScreen({
	sessions,
	selected,
	onSelect,
	onMutate,
	breadcrumbLabel,
	onBack,
	emptyMessage,
	activeTab,
	onSelectTab,
	onNewIssue,
}: {
	sessions: Session[];
	selected: Session | null;
	onSelect: (session: Session) => void;
	onMutate: () => void;
	breadcrumbLabel: string;
	onBack: () => void;
	emptyMessage: string;
	activeTab?: "sessions" | "crons" | "skills";
	onSelectTab?: (tab: "sessions" | "crons" | "skills" | "issues") => void;
	onNewIssue?: () => void;
}): React.ReactElement {
	return (
		<>
			{onSelectTab ? (
				<RepoTabs
					activeTab={activeTab ?? "sessions"}
					onSelectTab={onSelectTab}
					onNewIssue={onNewIssue}
				/>
			) : null}
			<Breadcrumb label={breadcrumbLabel} onBack={onBack} />
			{sessions.length === 0 ? (
				<EmptyState message={emptyMessage} />
			) : (
				<div className="workspace">
					<SessionListPane sessions={sessions} selected={selected} onSelect={onSelect} />
					<SessionDetail selected={selected} onMutate={onMutate} activeTab={activeTab} />
				</div>
			)}
		</>
	);
}
