import React, { useState } from "react";
import { Modal } from "../../components/Modal.js";
import { addRepo } from "../../api/repos.js";

/**
 * A repository rendered by {@link RepoManager}. Extends the accessible-repo
 * shape with two derived flags:
 * - `selected`: whether the user has checked this repo.
 * - `configured`: whether the repo is already persisted (enabled).
 */
export interface ManagedRepo {
	owner: string;
	repo: string;
	fullName: string;
	visibility?: "public" | "private" | "internal";
	selected: boolean;
	configured: boolean;
}

export interface RepoManagerProps {
	/** Repositories to display, already merged with selection/configured state. */
	repos: ManagedRepo[];
	/** True while the parent is fetching or refreshing the list. */
	loading?: boolean;
	/** Optional inline error banner. */
	error?: string | null;
	/** Optional success banner (e.g. "Repositories saved."). */
	savedMessage?: string | null;
	/** Show selection checkboxes and the Select All/Deselect All control. */
	selectable?: boolean;
	/** Toggle a single repo's selection. Required when `selectable`. */
	onToggleRepo?: (index: number) => void;
	/** Set every repo's selection to the given value. Required when `selectable`. */
	onSetAllSelected?: (selected: boolean) => void;
	/** Persist the current selection. When provided, a Save button is rendered. */
	onSave?: () => void;
	saving?: boolean;
	canSave?: boolean;
	saveLabel?: string;
	/** Refresh the list. When provided, a Refresh button is rendered. */
	onRefresh?: () => void;
	refreshing?: boolean;
	refreshLabel?: string;
	/**
	 * Show a manual "Add Repository" button that opens an owner/repo entry modal.
	 * On a successful add the parent's `onAdded` callback is invoked so it can
	 * refetch the list.
	 */
	allowManualAdd?: boolean;
	onAdded?: () => void;
	/** Optional descriptive text rendered above the list. */
	description?: React.ReactNode;
	/** Optional note rendered in the actions row (e.g. token status). */
	note?: React.ReactNode;
	emptyMessage?: string;
	loadingMessage?: string;
}

export function RepoManager({
	repos,
	loading = false,
	error = null,
	savedMessage = null,
	selectable = true,
	onToggleRepo,
	onSetAllSelected,
	onSave,
	saving = false,
	canSave = false,
	saveLabel = "Save Changes",
	onRefresh,
	refreshing = false,
	refreshLabel = "Refresh",
	allowManualAdd = false,
	onAdded,
	description,
	note,
	emptyMessage = "No repositories are available.",
	loadingMessage = "Loading repositories...",
}: RepoManagerProps): React.ReactElement {
	const [showAdd, setShowAdd] = useState(false);
	const [addOwner, setAddOwner] = useState("");
	const [addRepoName, setAddRepoName] = useState("");
	const [addLoading, setAddLoading] = useState(false);
	const [addError, setAddError] = useState<string | null>(null);

	const allSelected = repos.length > 0 && repos.every((r) => r.selected);
	const selectedCount = repos.filter((r) => r.selected).length;

	function openAddModal() {
		setShowAdd(true);
		setAddError(null);
	}

	function closeAddModal() {
		if (addLoading) return;
		setShowAdd(false);
		setAddError(null);
	}

	async function handleAddRepo(event: React.FormEvent) {
		event.preventDefault();
		setAddError(null);
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
				setShowAdd(false);
				onAdded?.();
			} else {
				setAddError(result.message ?? "Repository already configured");
			}
		} catch (err) {
			setAddError(err instanceof Error ? err.message : String(err));
		} finally {
			setAddLoading(false);
		}
	}

	return (
		<div className="repo-manager">
			{description ? <div className="repo-manager-description">{description}</div> : null}

			<div className="repo-manager-actions">
				{allowManualAdd ? (
					<button
						type="button"
						className="action-btn"
						onClick={openAddModal}
						disabled={loading}
					>
						➕ Add Repository
					</button>
				) : null}
				{onRefresh ? (
					<button
						type="button"
						className="action-btn"
						onClick={onRefresh}
						disabled={refreshing || loading}
					>
						{refreshing || loading ? `🔄 ${refreshLabel}...` : `🔄 ${refreshLabel}`}
					</button>
				) : null}
				{selectable && repos.length > 0 ? (
					<button
						type="button"
						className="action-btn"
						onClick={() => onSetAllSelected?.(!allSelected)}
					>
						{allSelected ? "Deselect All" : "Select All"}
					</button>
				) : null}
				{selectable && repos.length > 0 ? (
					<span className="repo-manager-count">
						{selectedCount} of {repos.length} selected
					</span>
				) : null}
				{note ? <span className="repo-manager-note">{note}</span> : null}
			</div>

			{error ? <div className="error-banner">{error}</div> : null}
			{savedMessage && !error ? <div className="success-banner">{savedMessage}</div> : null}

			{loading && repos.length === 0 ? (
				<div className="empty">{loadingMessage}</div>
			) : repos.length === 0 ? (
				<div className="empty">{emptyMessage}</div>
			) : (
				<div className="settings-repositories-list">
					<div className="settings-repositories-items">
						{repos.map((repo, i) => (
							<label
								key={repo.fullName}
								className={`settings-repository-row${repo.selected ? " selected" : ""}${repo.configured && repo.selected ? " configured" : ""}`}
							>
								{selectable ? (
									<input
										type="checkbox"
										checked={repo.selected}
										onChange={() => onToggleRepo?.(i)}
										aria-label={repo.fullName}
									/>
								) : null}
								<span className="settings-repository-name">{repo.fullName}</span>
								{repo.configured ? (
									<span className="settings-repository-badge enabled">enabled</span>
								) : null}
								{!repo.configured && repo.selected ? (
									<span className="settings-repository-badge new">new</span>
								) : null}
							</label>
						))}
					</div>
				</div>
			)}

			{onSave ? (
				<div className="settings-actions">
					<button
						className="action-btn restart"
						onClick={onSave}
						disabled={saving || !canSave}
						type="button"
					>
						{saving ? "Saving..." : saveLabel}
					</button>
				</div>
			) : null}

			{allowManualAdd ? (
				<Modal open={showAdd} onClose={closeAddModal} title="Add Repository">
					<form className="repo-add-form" onSubmit={handleAddRepo}>
						<p className="repo-add-hint">
							Enter the repository as <code>owner/repo-name</code>.
						</p>
						<div className="repo-add-fields">
							<label className="repo-add-label" htmlFor="repo-manager-add-owner">
								Owner
								<input
									id="repo-manager-add-owner"
									type="text"
									value={addOwner}
									onChange={(e) => setAddOwner(e.target.value)}
									placeholder="e.g. octocat"
									disabled={addLoading}
									aria-invalid={addError ? "true" : "false"}
									aria-describedby="repo-manager-add-error"
								/>
							</label>
							<label className="repo-add-label" htmlFor="repo-manager-add-repo">
								Repository name
								<input
									id="repo-manager-add-repo"
									type="text"
									value={addRepoName}
									onChange={(e) => setAddRepoName(e.target.value)}
									placeholder="e.g. hello-world"
									disabled={addLoading}
									aria-invalid={addError ? "true" : "false"}
									aria-describedby="repo-manager-add-error"
								/>
							</label>
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
							<p id="repo-manager-add-error" className="error-text" role="alert">
								{addError}
							</p>
						) : null}
					</form>
				</Modal>
			) : null}
		</div>
	);
}