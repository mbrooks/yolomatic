import React from "react";
import { RepoList } from "./RepoList.js";
import type { RepoSummary } from "../../app/types.js";

export function RepoListScreen({
	repos,
	inProgressCount,
	onSelectRepo,
	onSelectWorking,
}: {
	repos: RepoSummary[];
	inProgressCount: number;
	onSelectRepo: (owner: string, repo: string) => void;
	onSelectWorking: () => void;
}): React.ReactElement {
	return (
		<RepoList repos={repos} onSelect={onSelectRepo}>
			<div
				className="repo-card working-card"
				onClick={onSelectWorking}
				tabIndex={0}
				role="button"
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onSelectWorking();
					}
				}}
			>
				<div className="repo-card-name">Active Tasks</div>
				<div className="repo-card-meta">
					{inProgressCount} active task{inProgressCount !== 1 ? "s" : ""}
				</div>
			</div>
		</RepoList>
	);
}
