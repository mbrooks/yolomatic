import React from "react";
import { RepoManager, type ManagedRepo } from "../../repos/RepoManager.js";
import type { WizardState } from "../wizard-state.js";

export interface StepFiveWorkspaceInitProps {
	state: WizardState;
	onFetchRepos: () => Promise<void>;
	onToggleRepo: (index: number) => void;
	onSetAllReposSelected: (selected: boolean) => void;
	loading: boolean;
}

export function StepFiveWorkspaceInit({
	state,
	onFetchRepos,
	onToggleRepo,
	onSetAllReposSelected,
	loading,
}: StepFiveWorkspaceInitProps): React.ReactElement {
	return (
		<div className="onboarding-form">
			<RepoManager
				repos={state.repositories as ManagedRepo[]}
				loading={loading}
				error={state.error}
				selectable
				onToggleRepo={onToggleRepo}
				onSetAllSelected={onSetAllReposSelected}
				onRefresh={onFetchRepos}
				refreshing={loading}
				refreshLabel="Refresh"
				note={
					state.githubTokenProtected
						? "Using the configured GitHub token."
						: undefined
				}
				emptyMessage="No repositories are accessible to the configured GitHub account."
				loadingMessage={
					loading && state.repositories.length === 0
						? "Fetching repositories..."
						: "Loading repositories..."
				}
			/>
		</div>
	);
}