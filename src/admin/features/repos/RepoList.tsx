import React from "react";
import type { RepoSummary } from "../../app/types.js";

export function RepoList({
	repos,
	onSelect,
	children,
}: {
	repos: RepoSummary[];
	onSelect: (owner: string, repo: string) => void;
	children?: React.ReactNode;
}): React.ReactElement {
	if (repos.length === 0 && !children) {
		return (
			<div className="empty-state">
				<p>No repositories have been used yet.</p>
			</div>
		);
	}

	return (
		<div className="repo-list">
			{children}
			{repos.map((repo) => (
				<div
					key={`${repo.owner}/${repo.repo}`}
					className="repo-card"
					onClick={() => onSelect(repo.owner, repo.repo)}
					tabIndex={0}
					role="button"
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onSelect(repo.owner, repo.repo);
						}
					}}
				>
					<div className="repo-card-name">{repo.owner}/{repo.repo}</div>
					<div className="repo-card-meta">
						{repo.sessionCount} session{repo.sessionCount !== 1 ? "s" : ""}
						{repo.activeCount > 0 ? ` · ${repo.activeCount} active` : ""}
					</div>
				</div>
			))}
		</div>
	);
}
