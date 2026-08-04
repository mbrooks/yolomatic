import React, { useCallback, useEffect, useState } from "react";
import { fetchSettings, updateSettings } from "../../api/settings.js";
import { fetchOllamaSignInStatus, type OllamaSignInStatus } from "../../api/ollama.js";
import { navigate, SETTINGS_CATEGORY_TABS, DEFAULT_SETTINGS_TAB } from "../../app/routes.js";
import type { SettingView } from "../../../settings/model.js";
import { RestartBanner } from "../../components/RestartBanner.js";
import { ServerSkillsScreen } from "../skills/ServerSkillsScreen.js";
import { InvitationsSection } from "./InvitationsSection.js";
import { RepositoriesSettingsSection } from "./RepositoriesSettingsSection.js";
import { OllamaSignInPanel } from "./OllamaSignInPanel.js";
import { UsersScreen } from "../users/UsersScreen.js";
import type { SettingsCategoryTab } from "../../app/routes.js";

export type SettingsTab = SettingsCategoryTab | "skills" | "invitations" | "users";

const SERVER_SETTINGS_SECTIONS = [
	{ category: "server", label: "Server" },
	{ category: "authentication", label: "Authentication" },
	{ category: "file-system", label: "File System" },
	{ category: "logging", label: "Logging" },
] as const;

const SETTING_OPTIONS: Readonly<Record<string, readonly string[]>> = {
	github_event_mode: ["webhook", "polling", "both"],
	pi_agent_provider: ["ollama"],
};

export function SettingsScreen({
	onBack,
	onRerunOnboarding,
	tab = DEFAULT_SETTINGS_TAB,
}: {
	onBack: () => void;
	onRerunOnboarding?: () => void;
	tab?: SettingsTab;
}): React.ReactElement {
	const [settings, setSettings] = useState<SettingView[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [rerunningOnboarding, setRerunningOnboarding] = useState(false);
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

	const handleRerunOnboarding = useCallback(async () => {
		if (!window.confirm("Are you sure you want to rerun the on-boarding wizard?")) return;

		setRerunningOnboarding(true);
		setError(null);
		try {
			await updateSettings({ onboarding_complete: false });
			if (onRerunOnboarding) {
				onRerunOnboarding();
			} else {
				window.location.reload();
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setRerunningOnboarding(false);
		}
	}, [onRerunOnboarding]);

	const settingsSections = tab === "server" ? SERVER_SETTINGS_SECTIONS : null;
	const categories = settingsSections
		? new Set(settingsSections.map(({ category }) => category))
		: new Set<string>([tab]);
	const filteredSettings = tab === "skills" || tab === "invitations" || tab === "repositories" || tab === "users"
		? []
		: settings.filter((setting) => categories.has(setting.category) && setting.key !== "onboarding_complete");
	const piAgentProviderSetting = settings?.find((setting) => setting.key === "pi_agent_provider");
	const effectiveProvider =
		(edited.pi_agent_provider !== undefined ? String(edited.pi_agent_provider) : piAgentProviderSetting?.value) ??
		(piAgentProviderSetting?.default !== undefined ? String(piAgentProviderSetting.default) : "");
	const showOllamaPanel = tab === "ai-llm" && effectiveProvider === "ollama";
	const ollamaContainerSetting = settings?.find((setting) => setting.key === "ollama_container_name");
	const ollamaContainerName = String(
		(edited.ollama_container_name !== undefined
			? String(edited.ollama_container_name)
			: ollamaContainerSetting?.value) ??
		(ollamaContainerSetting?.default !== undefined ? String(ollamaContainerSetting.default) : "yeetomatic-ollama") ??
		"yeetomatic-ollama",
	);

	if (loading) {
		return (
			<div className="settings-screen">
				<header className="breadcrumb">
					<button onClick={onBack} type="button">← Back</button>
					<h2>Settings</h2>
				</header>
				<SettingsTabs
					activeTab={tab}
					onRerunOnboarding={handleRerunOnboarding}
					rerunningOnboarding={rerunningOnboarding}
				/>
				{tab === "repositories" ? (
					<RepositoriesSettingsSection />
				) : (
					<div className="empty">Loading settings...</div>
				)}
			</div>
		);
	}

	return (
		<div className="settings-screen">
			<header className="breadcrumb">
				<button onClick={onBack} type="button">← Back</button>
				<h2>Settings</h2>
			</header>
			<SettingsTabs
				activeTab={tab}
				onRerunOnboarding={handleRerunOnboarding}
				rerunningOnboarding={rerunningOnboarding}
			/>
			{error && <div className="error-banner">{error}</div>}
			{tab === "skills" ? (
				<ServerSkillsScreen showBreadcrumb={false} />
			) : tab === "invitations" ? (
				<InvitationsSection />
			) : tab === "repositories" ? (
				<RepositoriesSettingsSection />
			) : tab === "users" ? (
				<UsersScreen />
			) : (
				<>
					{pendingRestart && (
						<RestartBanner>A restart is required for some changes to take full effect.</RestartBanner>
					)}
					<div className="settings-list">
						{settingsSections ? (
							settingsSections.map(({ category, label }) => (
								<SettingsSection
									key={category}
									title={label}
									settings={filteredSettings.filter((setting) => setting.category === category)}
									edited={edited}
									changedKeys={changedKeys}
									onChange={handleChange}
								/>
							))
						) : (
							<SettingsRows
								settings={filteredSettings}
								edited={edited}
								changedKeys={changedKeys}
								onChange={handleChange}
							/>
						)}
					</div>

					{showOllamaPanel && (
						<OllamaSignInPanel
							containerName={ollamaContainerName}
						/>
					)}

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

function SettingsSection({
	title,
	settings,
	edited,
	changedKeys,
	onChange,
}: {
	title: string;
	settings: SettingView[];
	edited: Record<string, string | number | boolean>;
	changedKeys: Set<string>;
	onChange: (key: string, value: string | number | boolean) => void;
}): React.ReactElement {
	return (
		<section className="settings-section">
			<h3 className="settings-section-title">{title}</h3>
			<SettingsRows settings={settings} edited={edited} changedKeys={changedKeys} onChange={onChange} />
		</section>
	);
}

function SettingsRows({
	settings,
	edited,
	changedKeys,
	onChange,
}: {
	settings: SettingView[];
	edited: Record<string, string | number | boolean>;
	changedKeys: Set<string>;
	onChange: (key: string, value: string | number | boolean) => void;
}): React.ReactElement {
	return (
		<>
			{settings.map((setting) => (
				<SettingRow
					key={setting.key}
					setting={setting}
					editedValue={changedKeys.has(setting.key) ? edited[setting.key] : undefined}
					onChange={onChange}
				/>
			))}
		</>
	);
}

function SettingsTabs({
	activeTab,
	onRerunOnboarding,
	rerunningOnboarding,
}: {
	activeTab: SettingsTab;
	onRerunOnboarding: () => Promise<void>;
	rerunningOnboarding: boolean;
}): React.ReactElement {
	return (
		<div className="repo-tabs">
			{SETTINGS_CATEGORY_TABS.map(({ slug, label }) => (
				<button
					key={slug}
					className={`repo-tab${activeTab === slug ? " active" : ""}`}
					onClick={() => navigate({ screen: "settings", tab: slug })}
					type="button"
				>
					{label}
				</button>
			))}
			<button
				className={`repo-tab${activeTab === "skills" ? " active" : ""}`}
				onClick={() => navigate({ screen: "settings", tab: "skills" })}
				type="button"
			>
				Skills
			</button>
			<button
				className={`repo-tab${activeTab === "invitations" ? " active" : ""}`}
				onClick={() => navigate({ screen: "settings", tab: "invitations" })}
				type="button"
			>
				Invitations
			</button>
			<button
				className="repo-tab settings-rerun-onboarding"
				onClick={() => {
					void onRerunOnboarding();
				}}
				disabled={rerunningOnboarding}
				type="button"
			>
				{rerunningOnboarding ? "Starting On-Boarding..." : "Rerun On-Boarding"}
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
	const options = SETTING_OPTIONS[setting.key];

	return (
		<div className={`setting-row${isDirty ? " dirty" : ""}${setting.requiresRestart ? " requires-restart" : ""}`}>
			<label htmlFor={`setting-${setting.key}`}>
				<span className="setting-key">{setting.key}</span>
				{setting.requiresRestart && <span className="restart-badge">restart</span>}
				{setting.sensitive && <span className="sensitive-badge">sensitive</span>}
			</label>
			<p className="setting-description">{setting.description}</p>
			{options ? (
				<select
					id={`setting-${setting.key}`}
					value={String(displayValue)}
					onChange={(e) => onChange(setting.key, e.target.value)}
				>
					{options.map((option) => (
						<option key={option} value={option}>{option}</option>
					))}
				</select>
			) : setting.type === "boolean" ? (
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
