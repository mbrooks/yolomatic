import React, { useCallback, useEffect, useMemo, useState } from "react";
import { addRepo, listAccessibleRepos, removeRepo, type AccessibleRepo } from "../../api/repos.js";
import { RepoManager, type ManagedRepo } from "../repos/RepoManager.js";

function repoKey(owner: string, repo: string): string {
	return `${owner}/${repo}`.toLowerCase();
}

/**
 * Merge the accessible repositories returned by the API with the currently
 * configured repositories. Configured repos that no longer appear in the
 * accessible list are retained (with a placeholder visibility) so the user can
 * still deselect them.
 */
export function mergeRepositories(
	accessible: AccessibleRepo[],
	configured: Array<{ owner: string; repo: string }>,
): ManagedRepo[] {
	const configuredKeys = new Set(configured.map((r) => repoKey(r.owner, r.repo)));
	const merged: ManagedRepo[] = accessible.map((repo) => ({
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
	const [repos, setRepos] = useState<ManagedRepo[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	const fetchRepos = useCallback(async () => {
		setError(null);
		const data = await listAccessibleRepos();
		setRepos(mergeRepositories(data.repositories, data.configured));
	}, []);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		fetchRepos()
			.then(() => {
				if (cancelled) return;
				setLoading(false);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
		return () => { cancelled = true; };
	}, [fetchRepos]);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		setError(null);
		try {
			await fetchRepos();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRefreshing(false);
		}
	}, [fetchRepos]);

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

	return (
		<RepoManager
			repos={repos}
			loading={loading}
			error={error}
			savedMessage={savedAt !== null ? "Repositories saved." : null}
			selectable
			onToggleRepo={toggleRepo}
			onSetAllSelected={setAllSelected}
			onSave={handleSave}
			saving={saving}
			canSave={hasChanges}
			onRefresh={handleRefresh}
			refreshing={refreshing}
			allowManualAdd
			onAdded={handleRefresh}
			description={
				<>
					Choose which repositories TARS should manage. Selections are persisted
					to the <code>repositories</code> table.
				</>
			}
			emptyMessage="No repositories are available to the configured GitHub account."
			loadingMessage="Loading repositories..."
		/>
	);
}