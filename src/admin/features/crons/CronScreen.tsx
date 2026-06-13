import React, { useCallback, useState } from "react";
import { RepoScopedScreenShell } from "../../components/RepoScopedScreenShell.js";
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
	activeTab: "sessions" | "crons" | "skills" | "issues";
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
		<RepoScopedScreenShell
			owner={owner}
			repo={repo}
			activeTab={activeTab}
			onSelectTab={onSelectTab}
			onNewIssue={onNewIssue}
			onBack={onBack}
			loading={loading}
			loadingMessage="Loading crons..."
			empty={crons.length === 0 && !showForm}
			emptyMessage="No cron jobs for this repository."
			emptyAction={
					<button
						className="action-btn restart"
						onClick={() => setShowForm(true)}
						type="button"
					>
						+ New Cron Job
					</button>
			}
		>
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
		</RepoScopedScreenShell>
	);
}
