import React, { useMemo, useState } from "react";
import type { RepoSummary } from "../../app/types.js";
import { formatRelative } from "../../lib/format.js";

type SortKey = "repo" | "activeCount" | "sessionCount" | "cronCount" | "lastActivity";
type SortDir = "asc" | "desc";

function sortRepos(repos: RepoSummary[], key: SortKey, dir: SortDir): RepoSummary[] {
	const sorted = [...repos];
	sorted.sort((a, b) => {
		let cmp = 0;
		switch (key) {
			case "repo":
				cmp = `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`);
				break;
			case "activeCount":
				cmp = a.activeCount - b.activeCount || a.sessionCount - b.sessionCount;
				break;
			case "sessionCount":
				cmp = a.sessionCount - b.sessionCount || a.activeCount - b.activeCount;
				break;
			case "cronCount":
				cmp = a.cronCount - b.cronCount;
				break;
			case "lastActivity": {
				const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
				const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
				cmp = aTime - bTime;
				break;
			}
		}
		return dir === "asc" ? cmp : -cmp;
	});
	return sorted;
}

export function RepoInventoryScreen({
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
	const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "lastActivity", dir: "desc" });

	const sortedRepos = useMemo(
		() => sortRepos(repos, sort.key, sort.dir),
		[repos, sort.key, sort.dir],
	);

	function handleSort(key: SortKey) {
		setSort((prev) => ({
			key,
			dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc",
		}));
	}

	function sortIndicator(key: SortKey): string {
		if (sort.key !== key) return "";
		return sort.dir === "asc" ? " ▲" : " ▼";
	}

	return (
		<div className="repo-inventory">
			<div className="repo-inventory-header">
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
			</div>

			{repos.length === 0 ? (
				<div className="empty-state">
					<p>No repositories have been used yet.</p>
				</div>
			) : (
				<div className="repo-table-wrapper">
					<table className="repo-table">
						<thead>
							<tr>
								<th className="repo-th" onClick={() => handleSort("repo")}>
									Repository{sortIndicator("repo")}
								</th>
								<th className="repo-th" onClick={() => handleSort("activeCount")}>
									Active{sortIndicator("activeCount")}
								</th>
								<th className="repo-th" onClick={() => handleSort("sessionCount")}>
									Total{sortIndicator("sessionCount")}
								</th>
								<th className="repo-th" onClick={() => handleSort("cronCount")}>
									Crons{sortIndicator("cronCount")}
								</th>
								<th className="repo-th" onClick={() => handleSort("lastActivity")}>
									Last Activity{sortIndicator("lastActivity")}
								</th>
							</tr>
						</thead>
						<tbody>
							{sortedRepos.map((repo) => (
								<tr
									key={`${repo.owner}/${repo.repo}`}
									className="repo-tr"
									onClick={() => onSelectRepo(repo.owner, repo.repo)}
									tabIndex={0}
									role="button"
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											onSelectRepo(repo.owner, repo.repo);
										}
									}}
								>
									<td className="repo-td">
										<strong>
											{repo.owner}/{repo.repo}
										</strong>
									</td>
									<td className="repo-td">{repo.activeCount}</td>
									<td className="repo-td">{repo.sessionCount}</td>
									<td className="repo-td">{repo.cronCount}</td>
									<td className="repo-td">
										{repo.lastActivity ? formatRelative(repo.lastActivity) : "–"}
									</td>
								</tr>
							))}
							</tbody>
						</table>
					</div>
					<div className="repo-inventory-count">{repos.length} repo{repos.length !== 1 ? "s" : ""}</div>
				</div>
			)}
		</div>
	);
}
