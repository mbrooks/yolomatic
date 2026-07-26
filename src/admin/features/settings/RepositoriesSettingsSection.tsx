import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
	addRepo,
	listAccessibleRepos,
	removeRepo,
	type AccessibleRepo,
} from "../../api/repos.js";

interface SelectableRepo extends AccessibleRepo {
	selected: boolean;
	configured: boolean;
}

function repoKey(owner: string, repo: string): string {
	return `${owner}/${repo}`.toLowerCase();
}

/**
 * Merge the accessible repositories returned by the API with the currently
 * configured repositories. Configured repos that no longer appear in the
 * accessible list are retained (with a placeholder visibility) so the user can
 * still deselect them.
 */
function mergeRepositories(
	accessible: AccessibleRepo[],
	configured: Array<{ owner: string; repo: string }>,
): SelectableRepo[] {
	const configuredKeys = new Set(configured.map((r) => repoKey(r.owner, r.repo)));
	const merged: SelectableRepo[] = accessible.map((repo) => ({
		...repo,
		selected: configuredKeys.has(repoKey(repo.owner, repo.repo)),
		configured: configuredKeys.has(repoKey(repo.owner, repo.repo)),
	}));

	const accessibleKeys = new Set(accessible.map((r) => repoKey(r.owner, r.repo)));
	for (const repo of configured) {
		const key = repoKey(repo.owner, repo.repo);
		if (accessibleKeys.has(key)) {
			continue;
		}
		merged.push({
			owner: repo.owner,
			repo: repo.repo,
			fullName: `${repo.owner}/${repo.repo}`,
			visibility: "private",
			selected: true,
			configured: true,
		});
	}

	merged.sort((a, b) => a.fullName.localeCompare(b.fullName));
	return merged;
}

export function RepositoriesSettingsSection(): React.ReactElement {
	const [repos, setRepos] = useState<SelectableRepo[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		listAccessibleRepos()
			.then((data) => {
				if (cancelled) return;
				setRepos(mergeRepositories(data.repositories, data.configured));
				setLoading(false);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
		return () => { cancelled = true; };
	}, []);

	const toggleRepo = useCallback((index: number) => {
		setRepos((prev) => {
			const next = [...prev];
			next[index] = { ...next[index], selected: !next[index].selected };
			return next;
		});
		setSavedAt(null);
	}, []);

	const setAllSelected = useCallback((selected: boolean) => {
		setRepos((prev) => prev.map((repo) => ({ ...repo, selected })));
		setSavedAt(null);
	}, []);

	const allSelected = repos.length > 0 && repos.every((r) => r.selected);
	const selectedCount = repos.filter((r) => r.selected).length;

	const hasChanges = useMemo(() => {
		return repos.some((r) => r.selected !== r.configured);
	}, [repos]);

	const handleSave = useCallback(async () => {
		if (!hasChanges) return;
		setSaving(true);
		setError(null);
		try {
			// Add newly selected repos and remove newly deselected configured repos
			// via the table-backed repos API. Failures are collected and reported.
			const failures: string[] = [];
			for (const repo of repos) {
				const key = repoKey(repo.owner, repo.repo);
				if (repo.selected && !repo.configured) {
					try {
						await addRepo(repo.owner, repo.repo);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						failures.push(`add ${key}: ${message}`);
					}
				} else if (!repo.selected && repo.configured) {
					try {
						await removeRepo(repo.owner, repo.repo);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						failures.push(`remove ${key}: ${message}`);
					}
				}
			}
			if (failures.length > 0) {
				throw new Error(failures.join("; "));
			}
			setRepos((prev) =>
				prev.map((repo) => ({ ...repo, configured: repo.selected })),
			);
			setSavedAt(Date.now());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [hasChanges, repos]);

	if (loading) {
		return <div className="empty">Loading repositories...</div>;
	}

	return (
		<div className="settings-repositories">
			<p className="setting-description">
				Choose which repositories TARS should manage. Selections are persisted
				to the <code>repositories</code> table.
			</p>

			{error && <div className="error-banner">{error}</div>}
			{savedAt !== null && !error && (
				<div className="success-banner">Repositories saved.</div>
			)}

			{repos.length === 0 ? (
				<div className="empty">
					No repositories are available to the configured GitHub account.
				</div>
			) : (
				<div className="settings-repositories-list">
					<div className="settings-repositories-actions">
						<button
							type="button"
							className="action-btn"
							onClick={() => setAllSelected(!allSelected)}
						>
							{allSelected ? "Deselect All" : "Select All"}
						</button>
						<span className="settings-repositories-count">
							{selectedCount} of {repos.length} selected
						</span>
					</div>

					<div className="settings-repositories-items">
						{repos.map((repo, i) => (
							<label
								key={repo.fullName}
								className={`settings-repository-row${repo.selected ? " selected" : ""}${repo.configured && repo.selected ? " configured" : ""}`}
							>
								<input
									type="checkbox"
									checked={repo.selected}
									onChange={() => toggleRepo(i)}
								/>
								<span className="settings-repository-name">{repo.fullName}</span>
								{!repo.configured && repo.selected && (
									<span className="settings-repository-badge new">new</span>
								)}
							</label>
						))}
					</div>
				</div>
			)}

			<div className="settings-actions">
				<button
					className="action-btn restart"
					onClick={handleSave}
					disabled={saving || !hasChanges}
					type="button"
				>
					{saving ? "Saving..." : "Save Changes"}
				</button>
			</div>
		</div>
	);
}