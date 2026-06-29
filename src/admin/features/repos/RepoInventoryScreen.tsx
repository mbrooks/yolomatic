import React, { useMemo, useState } from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { Modal } from "../../components/Modal.js";
import type { RepoSummary } from "../../app/types.js";
import { formatRelative } from "../../lib/format.js";
import { scanRepos, addRepo } from "../../api/repos.js";

type SortKey = "repo" | "activeCount" | "sessionCount" | "lastActivity";
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
	onSelectRepo,
	onBack,
	onRescanComplete,
}: {
	repos: RepoSummary[];
	onSelectRepo: (owner: string, repo: string) => void;
	onBack: () => void;
	onRescanComplete?: () => void;
}): React.ReactElement {
	const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "lastActivity", dir: "desc" });
	const [scanning, setScanning] = useState(false);
	const [scanError, setScanError] = useState<string | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const [addOwner, setAddOwner] = useState("");
	const [addRepoName, setAddRepoName] = useState("");
	const [addLoading, setAddLoading] = useState(false);
	const [addError, setAddError] = useState<string | null>(null);
	const [addMessage, setAddMessage] = useState<string | null>(null);

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

	async function handleRescan() {
		setScanning(true);
		setScanError(null);
		try {
			await scanRepos();
			onRescanComplete?.();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setScanError(message);
		} finally {
			setScanning(false);
		}
	}

	function openAddModal() {
		setShowAdd(true);
		setAddError(null);
		setAddMessage(null);
	}

	function closeAddModal() {
		if (addLoading) return;
		setShowAdd(false);
		setAddError(null);
		setAddMessage(null);
	}

	async function handleAddRepo(event: React.FormEvent) {
		event.preventDefault();
		setAddError(null);
		setAddMessage(null);
		const owner = addOwner.trim();
		const repo = addRepoName.trim();
		if (!owner || !repo) {
			setAddError("Owner and repository name are required");
			return;
		}
		setAddLoading(true);
		try {
			const result = await addRepo(owner, repo);
			if (result.added) {
				setAddOwner("");
				setAddRepoName("");
				setAddMessage(`Added ${result.fullName ?? `${result.owner}/${result.repo}`}`);
				setShowAdd(false);
				onRescanComplete?.();
			} else {
				setAddMessage(result.message ?? "Repository already configured");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setAddError(message);
		} finally {
			setAddLoading(false);
		}
	}

	return (
		<div className="repo-inventory">
			<div className="repo-inventory-header">
				<Breadcrumb label="Repositories" onBack={onBack} />
				<div className="repo-inventory-actions">
					<button
						type="button"
						className="action-btn"
						onClick={() => {
							void openAddModal();
						}}
					>
						➕ Add Repository
					</button>
					<button
						type="button"
						className="action-btn"
						onClick={() => {
							void handleRescan();
						}}
						disabled={scanning}
					>
						{scanning ? "🔄 Scanning..." : "🔄 Rescan"}
					</button>
				</div>
			</div>
			{scanError ? (
				<div className="empty-state">
					<p className="error-text">Rescan failed: {scanError}</p>
				</div>
			) : null}
			<Modal open={showAdd} onClose={closeAddModal} title="Add Repository">
				<form className="repo-add-form" onSubmit={handleAddRepo}>
					<p className="repo-add-hint">Enter the repository as <code>owner/repo-name</code>.</p>
					<div className="repo-add-fields">
						<label className="repo-add-label" htmlFor="repo-add-owner">
							Owner
						</label>
						<input
							id="repo-add-owner"
							type="text"
							value={addOwner}
							onChange={(e) => setAddOwner(e.target.value)}
							placeholder="e.g. octocat"
							disabled={addLoading}
							aria-invalid={addError ? "true" : "false"}
							aria-describedby="repo-add-error"
						/>

						<label className="repo-add-label" htmlFor="repo-add-repo">
							Repository name
						</label>
						<input
							id="repo-add-repo"
							type="text"
							value={addRepoName}
							onChange={(e) => setAddRepoName(e.target.value)}
							placeholder="e.g. hello-world"
							disabled={addLoading}
							aria-invalid={addError ? "true" : "false"}
							aria-describedby="repo-add-error"
						/>
					</div>
					<div className="repo-add-actions">
						<button
							type="button"
							className="action-btn"
							onClick={closeAddModal}
							disabled={addLoading}
							aria-label="Cancel"
						>
							Cancel
						</button>
						<button type="submit" className="action-btn" disabled={addLoading}>
							{addLoading ? "Adding..." : "Add Repository"}
						</button>
					</div>
					{addError ? (
						<p id="repo-add-error" className="error-text" role="alert">
							{addError}
						</p>
					) : null}
					{addMessage ? (
						<p className={addError ? "error-text" : "success-text"} role="status">
							{addMessage}
						</p>
					) : null}
				</form>
			</Modal>
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
									<td className="repo-td">
										{repo.lastActivity ? formatRelative(repo.lastActivity) : "–"}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<div className="repo-inventory-count">{repos.length} repo{repos.length !== 1 ? "s" : ""}</div>
				</div>
			)}
		</div>
	);
}
