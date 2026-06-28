import React, { useCallback, useEffect, useMemo, useState } from "react";
import { fetchRepoSettings, updateRepoSettings, type RepoSettingView } from "../../api/repo-settings.js";
import { RepoScopedScreenShell } from "../../components/RepoScopedScreenShell.js";
import { RestartBanner } from "../../components/RestartBanner.js";

export function RepoSettingsScreen({
	owner,
	repo,
	onBack,
	onSelectTab,
}: {
	owner: string;
	repo: string;
	onBack: () => void;
	onSelectTab: (tab: "sessions" | "skills" | "issues" | "settings") => void;
}): React.ReactElement {
	const [settings, setSettings] = useState<RepoSettingView[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pendingRestart, setPendingRestart] = useState(false);
	const [edited, setEdited] = useState<Record<string, string>>({});
	const [changedKeys, setChangedKeys] = useState<Set<string>>(new Set());

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const data = await fetchRepoSettings(owner, repo);
			setSettings(data.settings);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [owner, repo]);

	useEffect(() => {
		void load();
	}, [load]);

	const handleChange = useCallback((key: string, value: string) => {
		setEdited((prev) => ({ ...prev, [key]: value }));
		setChangedKeys((prev) => new Set(prev).add(key));
	}, []);

	const handleSave = useCallback(async () => {
		if (changedKeys.size === 0) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const body: Record<string, string> = {};
			for (const key of changedKeys) {
				body[key] = edited[key] ?? "";
			}
			const result = await updateRepoSettings(owner, repo, body);
			setPendingRestart(result.requiresRestart.length > 0);
			setEdited({});
			setChangedKeys(new Set());
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [changedKeys, edited, load, owner, repo]);

	const empty = useMemo(() => settings.length === 0 && !loading, [settings.length, loading]);

	return (
		<RepoScopedScreenShell
			owner={owner}
			repo={repo}
			activeTab="settings"
			onSelectTab={onSelectTab}
			onBack={onBack}
			loading={loading}
			loadingMessage="Loading settings..."
			empty={empty}
			emptyMessage="No settings available for this repository."
		>
			<div className="detail-pane">
				<h2>Repository Settings</h2>
				<p className="setting-description">Override the global defaults for this repository only.</p>
				{pendingRestart ? <RestartBanner>A restart is required for event mode changes to take effect.</RestartBanner> : null}
				{error ? <div className="error-banner">{error}</div> : null}
				<div className="settings-list">
					{settings.map((setting) => {
						const displayValue = changedKeys.has(setting.key) ? (edited[setting.key] ?? "") : (setting.override ?? "");
						return (
							<div key={setting.key} className={`setting-row${changedKeys.has(setting.key) ? " dirty" : ""}`}>
								<label htmlFor={`repo-setting-${setting.key}`}>
									<span className="setting-key">{setting.key}</span>
									{setting.requiresRestart ? <span className="restart-badge">restart</span> : null}
								</label>
								<p className="setting-description">{setting.description}</p>
								{setting.options ? (
									<select
										id={`repo-setting-${setting.key}`}
										value={displayValue}
										onChange={(event) => handleChange(setting.key, event.target.value)}
									>
										<option value="">Use global default ({setting.default})</option>
										{setting.options.map((option) => (
											<option key={option} value={option}>
												{option}
											</option>
										))}
									</select>
								) : (
									<input
										id={`repo-setting-${setting.key}`}
										type="text"
										value={displayValue}
										placeholder={`Use global default (${setting.default})`}
										onChange={(event) => handleChange(setting.key, event.target.value)}
									/>
								)}
								<span className="setting-default">
									Effective: {setting.value} {setting.inherited ? "(global)" : "(override)"}
								</span>
							</div>
						);
					})}
				</div>
				<div className="settings-actions">
					<button
						className="action-btn restart"
						type="button"
						onClick={() => {
							void handleSave();
						}}
						disabled={saving || changedKeys.size === 0}
					>
						{saving ? "Saving..." : "Save Changes"}
					</button>
				</div>
			</div>
		</RepoScopedScreenShell>
	);
}
