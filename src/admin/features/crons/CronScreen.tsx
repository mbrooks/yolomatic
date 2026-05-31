import React, { useCallback, useState } from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { EmptyState } from "../../components/EmptyState.js";
import { RepoTabs } from "../../components/RepoTabs.js";
import type { CronJob } from "../../app/types.js";
import { useRepoCrons } from "./useRepoCrons.js";
import { CronListPane } from "./CronListPane.js";
import { CronForm } from "./CronForm.js";
import { CronDetail } from "./CronDetail.js";

export function CronScreen({
	owner,
	repo,
	activeTab,
	onSelectTab,
	onBack,
	onNewIssue,
}: {
	owner: string;
	repo: string;
	activeTab: "sessions" | "crons" | "skills";
	onSelectTab: (tab: "sessions" | "crons" | "skills" | "issues") => void;
	onBack: () => void;
	onNewIssue?: () => void;
}): React.ReactElement {
	const { crons, loading, reload } = useRepoCrons(owner, repo);
	const [selectedCron, setSelectedCron] = useState<CronJob | null>(null);
	const [showForm, setShowForm] = useState(false);

	const handleMutate = useCallback(() => {
		reload();
		setSelectedCron(null);
	}, [reload]);

	return (
		<>
			<RepoTabs activeTab={activeTab} onSelectTab={onSelectTab} onNewIssue={onNewIssue} />
			<Breadcrumb label={`${owner}/${repo}`} onBack={onBack} />
			{loading ? (
				<div className="empty">Loading crons...</div>
			) : crons.length === 0 && !showForm ? (
				<EmptyState message="No cron jobs for this repository.">
					<button
						className="action-btn restart"
						onClick={() => setShowForm(true)}
						type="button"
					>
						+ New Cron Job
					</button>
				</EmptyState>
			) : (
				<div className="workspace">
					<CronListPane
						crons={crons}
						selectedCron={selectedCron}
						onSelect={(cron) => {
							setSelectedCron(cron);
							setShowForm(false);
						}}
						onCreate={() => {
							setShowForm(true);
							setSelectedCron(null);
						}}
					/>

					{showForm ? (
						<CronForm
							owner={owner}
							repo={repo}
							existing={selectedCron}
							onComplete={handleMutate}
							onCancel={() => {
								setShowForm(false);
							}}
						/>
					) : (
						<CronDetail
							cron={selectedCron}
							owner={owner}
							repo={repo}
							onMutate={handleMutate}
							onEdit={() => setShowForm(true)}
						/>
					)}
				</div>
			)}
		</>
	);
}
