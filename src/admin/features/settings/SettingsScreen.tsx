import React, { useCallback, useEffect, useState } from "react";
import { fetchSettings, updateSettings } from "../../api/settings.js";
import { navigate } from "../../app/routes.js";
import type { SettingView } from "../../../settings/model.js";
import { RestartBanner } from "../../components/RestartBanner.js";
import { ServerSkillsScreen } from "../skills/ServerSkillsScreen.js";

export function SettingsScreen({
	onBack,
	tab = "general",
}: {
	onBack: () => void;
	tab?: "general" | "skills";
}): React.ReactElement {
	const [settings, setSettings] = useState<SettingView[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pendingRestart, setPendingRestart] = useState(false);
	const [edited, setEdited] = useState<Record<string, string | number | boolean>>({});
	const [changedKeys, setChangedKeys] = useState<Set<string>>(new Set());

	useEffect(() => {
		let cancelled = false;
		fetchSettings()
			.then((data) => {
				if (!cancelled) {
					setSettings(data.settings);
					setLoading(false);
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
					setLoading(false);
				}
			});
		return () => { cancelled = true; };
	}, []);

	const handleChange = useCallback((key: string, value: string | number | boolean) => {
		setEdited((prev) => ({ ...prev, [key]: value }));
		setChangedKeys((prev) => new Set(prev).add(key));
	}, []);

	const handleSave = useCallback(async () => {
		if (changedKeys.size === 0) return;
		setSaving(true);
		setError(null);
		try {
			const body: Record<string, string | number | boolean> = {};
			for (const key of changedKeys) {
				body[key] = edited[key];
			}
			const result = await updateSettings(body);
			setPendingRestart(result.requiresRestart.length > 0);
			setChangedKeys(new Set());
			setEdited({});
			// Refresh
			const data = await fetchSettings();
			setSettings(data.settings);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [changedKeys, edited]);

	if (loading) {
		return (
			<div className="settings-screen">
				<header className="breadcrumb">
					<button onClick={onBack} type="button">← Back</button>
					<h2>Settings</h2>
				</header>
				<SettingsTabs activeTab={tab} />
				<div className="empty">Loading settings...</div>
			</div>
		);
	}

	return (
		<div className="settings-screen">
			<header className="breadcrumb">
				<button onClick={onBack} type="button">← Back</button>
				<h2>Settings</h2>
			</header>
			<SettingsTabs activeTab={tab} />
			{tab === "skills" ? (
				<ServerSkillsScreen showBreadcrumb={false} />
			) : (
				<>
					{pendingRestart && (
						<RestartBanner>A restart is required for some changes to take full effect.</RestartBanner>
					)}
					{error && <div className="error-banner">{error}</div>}

					<div className="settings-list">
						{settings.map((setting) => (
							<SettingRow
								key={setting.key}
								setting={setting}
								editedValue={changedKeys.has(setting.key) ? edited[setting.key] : undefined}
								onChange={handleChange}
							/>
						))}
					</div>

					<div className="settings-actions">
						<button
							className="action-btn restart"
							onClick={handleSave}
							disabled={saving || changedKeys.size === 0}
							type="button"
						>
							{saving ? "Saving..." : "Save Changes"}
						</button>
					</div>
				</>
			)}
		</div>
	);
}

function SettingsTabs({ activeTab }: { activeTab: "general" | "skills" }): React.ReactElement {
	return (
		<div className="repo-tabs">
			<button
				className={`repo-tab${activeTab === "general" ? " active" : ""}`}
				onClick={() => navigate({ screen: "settings", tab: "general" })}
				type="button"
			>
				General
			</button>
			<button
				className={`repo-tab${activeTab === "skills" ? " active" : ""}`}
				onClick={() => navigate({ screen: "settings", tab: "skills" })}
				type="button"
			>
				Skills
			</button>
		</div>
	);
}

function SettingRow({
	setting,
	editedValue,
	onChange,
}: {
	setting: SettingView;
	editedValue: string | number | boolean | undefined;
	onChange: (key: string, value: string | number | boolean) => void;
}): React.ReactElement {
	const displayValue = editedValue !== undefined ? editedValue : setting.value;
	const isDirty = editedValue !== undefined;

	return (
		<div className={`setting-row${isDirty ? " dirty" : ""}${setting.requiresRestart ? " requires-restart" : ""}`}>
			<label htmlFor={`setting-${setting.key}`}>
				<span className="setting-key">{setting.key}</span>
				{setting.requiresRestart && <span className="restart-badge">restart</span>}
				{setting.sensitive && <span className="sensitive-badge">sensitive</span>}
			</label>
			<p className="setting-description">{setting.description}</p>
			{setting.type === "boolean" ? (
				<select
					id={`setting-${setting.key}`}
					value={displayValue === true ? "true" : "false"}
					onChange={(e) => onChange(setting.key, e.target.value === "true")}
				>
					<option value="true">true</option>
					<option value="false">false</option>
				</select>
			) : setting.type === "number" ? (
				<input
					id={`setting-${setting.key}`}
					type="number"
					value={String(displayValue)}
					onChange={(e) => onChange(setting.key, Number.parseInt(e.target.value, 10) || 0)}
				/>
			) : (
				<input
					id={`setting-${setting.key}`}
					type={setting.sensitive ? "password" : "text"}
					value={String(displayValue)}
					onChange={(e) => onChange(setting.key, e.target.value)}
				/>
			)}
			{setting.default !== undefined && (
				<span className="setting-default">Default: {String(setting.default)}</span>
			)}
		</div>
	);
}
