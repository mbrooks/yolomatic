import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
	submitOnboarding,
	verifyGitHubToken,
	generateWebhookSecret,
	listAccessibleRepositories,
	initializeWorkspaces,
} from "../../api/onboarding.js";

interface WizardState {
	step: number;
	adminUsername: string;
	adminPassword: string;
	githubToken: string;
	githubUsername: string;
	githubUsernameConfirmed: boolean;
	webhookSecret: string;
	webhookSecretConfirmed: boolean;
	repositories: Array<{ owner: string; repo: string; fullName: string; selected: boolean }>;
	error: string | null;
}

const STORAGE_KEY = "tars-onboarding-wizard";
const TOTAL_STEPS = 4;

function generatePassword(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_+=";
	const array = new Uint8Array(24);
	window.crypto.getRandomValues(array);
	let password = "";
	for (let i = 0; i < array.length; i++) {
		password += chars[array[i] % chars.length];
	}
	return password;
}

function loadState(): WizardState {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as WizardState;
			return { ...getDefaultState(), ...parsed, error: null };
		}
	} catch {
		// ignore
	}
	return getDefaultState();
}

function saveState(state: WizardState): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// ignore
	}
}

function getDefaultState(): WizardState {
	return {
		step: 1,
		adminUsername: "admin",
		adminPassword: generatePassword(),
		githubToken: "",
		githubUsername: "",
		githubUsernameConfirmed: false,
		webhookSecret: "",
		webhookSecretConfirmed: false,
		repositories: [],
		error: null,
	};
}

export function OnboardingWizard(): React.ReactElement {
	const [state, setState] = useState<WizardState>(() => loadState());
	const [loading, setLoading] = useState(false);
	const [done, setDone] = useState(false);

	useEffect(() => {
		saveState(state);
	}, [state]);

	const setError = useCallback((error: string | null) => {
		setState((prev) => ({ ...prev, error }));
	}, []);

	const goToStep = useCallback((step: number) => {
		setState((prev) => ({ ...prev, step: Math.max(1, Math.min(TOTAL_STEPS, step)), error: null }));
	}, []);

	const updateField = useCallback(<K extends keyof WizardState>(key: K, value: WizardState[K]) => {
		setState((prev) => ({ ...prev, [key]: value, error: null }));
	}, []);

	const handleVerifyToken = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await verifyGitHubToken(state.githubToken.trim());
			setState((prev) => ({ ...prev, githubUsername: result.username, githubUsernameConfirmed: true }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [state.githubToken, setError]);

	const handleGenerateSecret = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await generateWebhookSecret();
			setState((prev) => ({ ...prev, webhookSecret: result.secret }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [setError]);

	const handleFetchRepos = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await listAccessibleRepositories(state.githubToken.trim());
			const repos = result.repositories.map((r) => ({ ...r, selected: true }));
			setState((prev) => ({ ...prev, repositories: repos }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [state.githubToken, setError]);

	const toggleRepo = useCallback((index: number) => {
		setState((prev) => {
			const repos = [...prev.repositories];
			repos[index] = { ...repos[index], selected: !repos[index].selected };
			return { ...prev, repositories: repos };
		});
	}, []);

	const handleFinish = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const selectedRepos = state.repositories.filter((r) => r.selected);
			if (selectedRepos.length > 0) {
				await initializeWorkspaces({
					token: state.githubToken.trim(),
					username: state.githubUsername.trim(),
					repos: selectedRepos.map((r) => ({ owner: r.owner, repo: r.repo })),
				});
			}

			await submitOnboarding({
				github_token: state.githubToken.trim(),
				github_username: state.githubUsername.trim(),
				webhook_secret: state.webhookSecret.trim(),
				admin_username: state.adminUsername.trim(),
				admin_password: state.adminPassword.trim(),
			});

			localStorage.removeItem(STORAGE_KEY);
			setDone(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setLoading(false);
		}
	}, [state]);

	const handleCancel = useCallback(() => {
		if (confirm("Are you sure you want to cancel the onboarding? Your progress will be lost.")) {
			localStorage.removeItem(STORAGE_KEY);
			window.location.reload();
		}
	}, []);

	const canGoNext = useMemo(() => {
		switch (state.step) {
			case 1:
				return state.adminUsername.trim().length > 0 && state.adminPassword.trim().length > 0;
			case 2:
				return state.githubToken.trim().length > 0 && state.githubUsernameConfirmed;
			case 3:
				return state.webhookSecret.trim().length >= 128 && state.webhookSecretConfirmed;
			case 4:
				return true;
			default:
				return false;
		}
	}, [state]);

	if (done) {
		return (
			<div className="onboarding-screen">
				<div className="onboarding-card">
					<h2>Setup Complete</h2>
					<p className="onboarding-subtitle">
						Your settings have been saved. Restart TARS to finish and start working.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="onboarding-screen">
			<div className="onboarding-card">
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
					<h1>Welcome to TARS</h1>
					<span style={{ color: "var(--muted)", fontSize: "0.875rem" }}>Step {state.step} of {TOTAL_STEPS}</span>
				</div>
				<div
					style={{
						display: "flex",
						gap: "0.25rem",
						marginBottom: "1.5rem",
					}}
				>
					{Array.from({ length: TOTAL_STEPS }, (_, i) => (
						<div
							key={i}
							style={{
								flex: 1,
								height: "4px",
								borderRadius: "2px",
								background: i < state.step ? "var(--blue)" : "var(--border)",
								transition: "background 0.2s ease",
							}}
						/>
					))}
				</div>
				<p className="onboarding-subtitle">{getStepSubtitle(state.step)}</p>

				{state.error && <div className="error-banner">{state.error}</div>}

				{state.step === 1 && (
					<StepOneAdminCredentials
						state={state}
						updateField={updateField}
						onGeneratePassword={() => updateField("adminPassword", generatePassword())}
					/>
				)}
				{state.step === 2 && (
					<StepTwoGitHubIntegration
						state={state}
						updateField={updateField}
						onVerifyToken={handleVerifyToken}
						loading={loading}
					/>
				)}
				{state.step === 3 && (
					<StepThreeWebhookSecurity
						state={state}
						updateField={updateField}
						onGenerateSecret={handleGenerateSecret}
						loading={loading}
					/>
				)}
				{state.step === 4 && (
					<StepFourWorkspaceInit
						state={state}
						updateField={updateField}
						onFetchRepos={handleFetchRepos}
						onToggleRepo={toggleRepo}
						onFinish={handleFinish}
						loading={loading}
					/>
				)}

				<div style={{ display: "flex", gap: "0.75rem", marginTop: "1.5rem", justifyContent: "space-between" }}>
					<div style={{ display: "flex", gap: "0.75rem" }}>
						{state.step > 1 && (
							<button
								className="action-btn"
								style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
								type="button"
								onClick={() => goToStep(state.step - 1)}
								disabled={loading}
							>
								Back
							</button>
						)}
						<button
							className="action-btn"
							style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--red)" }}
							type="button"
								onClick={handleCancel}
								disabled={loading}
							>
							Cancel
						</button>
					</div>
					{state.step < TOTAL_STEPS ? (
						<button
							className="action-btn restart"
							type="button"
							onClick={() => goToStep(state.step + 1)}
							disabled={!canGoNext || loading}
						>
							Next
						</button>
					) : (
						<button
							className="action-btn restart"
							type="button"
							onClick={handleFinish}
							disabled={!canGoNext || loading}
						>
							{loading ? "Initializing..." : "Initialize & Finish"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

function getStepSubtitle(step: number): string {
	switch (step) {
		case 1:
			return "Set up your admin credentials for the dashboard.";
		case 2:
			return "Connect your GitHub account with a Personal Access Token.";
		case 3:
			return "Secure your webhook with a high-entropy secret.";
		case 4:
			return "Initialize workspaces for the repositories you want TARS to manage.";
		default:
			return "";
	}
}

function StepOneAdminCredentials({
	state,
	updateField,
	onGeneratePassword,
}: {
	state: WizardState;
	updateField: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
	onGeneratePassword: () => void;
}): React.ReactElement {
	const [showPassword, setShowPassword] = useState(true);

	return (
		<div className="onboarding-form">
			<div className="form-group">
				<label htmlFor="admin_username">Admin Username</label>
				<input
					id="admin_username"
					type="text"
					value={state.adminUsername}
					onChange={(e) => updateField("adminUsername", e.target.value)}
					placeholder="admin"
					required
				/>
				<span className="setting-description">Username for the admin dashboard</span>
			</div>
			<div className="form-group">
				<label htmlFor="admin_password">Admin Password</label>
				<div style={{ display: "flex", gap: "0.5rem" }}>
					<input
						id="admin_password"
						type={showPassword ? "text" : "password"}
						value={state.adminPassword}
						onChange={(e) => updateField("adminPassword", e.target.value)}
						placeholder="••••••"
						required
						style={{ flex: 1 }}
					/>
					<button
						type="button"
						className="action-btn"
						style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", whiteSpace: "nowrap" }}
						onClick={onGeneratePassword}
					>
						Regenerate
					</button>
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.35rem" }}>
					<label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.875rem", color: "var(--muted)" }}>
						<input
							type="checkbox"
							checked={showPassword}
							onChange={(e) => setShowPassword(e.target.checked)}
						/>
						Show password
					</label>
				</div>
				<span className="setting-description">A strong password has been suggested. You may override it.</span>
			</div>
		</div>
	);
}

function StepTwoGitHubIntegration({
	state,
	updateField,
	onVerifyToken,
	loading,
}: {
	state: WizardState;
	updateField: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
	onVerifyToken: () => Promise<void>;
	loading: boolean;
}): React.ReactElement {
	return (
		<div className="onboarding-form">
			<div className="form-group">
				<label htmlFor="github_token">GitHub PAT (Personal Access Token)</label>
				<div style={{ display: "flex", gap: "0.5rem" }}>
					<input
						id="github_token"
						type="password"
						value={state.githubToken}
						onChange={(e) => {
							updateField("githubToken", e.target.value);
							updateField("githubUsernameConfirmed", false);
							updateField("githubUsername", "");
						}}
						placeholder="ghp_..."
						required
						style={{ flex: 1 }}
					/>
					<button
						type="button"
						className="action-btn"
						style={{ background: "var(--blue)", color: "#000", whiteSpace: "nowrap" }}
						onClick={onVerifyToken}
						disabled={loading || !state.githubToken.trim()}
					>
						{loading ? "Verifying..." : "Verify"}
					</button>
				</div>
				<span className="setting-description">Personal access token with repo and issues scope</span>
			</div>

			{state.githubUsernameConfirmed && (
				<div className="form-group">
					<label htmlFor="github_username">GitHub Username</label>
					<input
						id="github_username"
						type="text"
						value={state.githubUsername}
						onChange={(e) => updateField("githubUsername", e.target.value)}
						placeholder="username"
						required
					/>
					<span className="setting-description">Inferred from your token. Confirm or edit if needed.</span>
				</div>
			)}
		</div>
	);
}

function StepThreeWebhookSecurity({
	state,
	updateField,
	onGenerateSecret,
	loading,
}: {
	state: WizardState;
	updateField: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
	onGenerateSecret: () => Promise<void>;
	loading: boolean;
}): React.ReactElement {
	return (
		<div className="onboarding-form">
			<div className="form-group">
				<label htmlFor="webhook_secret">Webhook Secret</label>
				<div style={{ display: "flex", gap: "0.5rem" }}>
					<input
						id="webhook_secret"
						type={state.webhookSecretConfirmed ? "text" : "password"}
						value={state.webhookSecret}
						onChange={(e) => updateField("webhookSecret", e.target.value)}
						placeholder="Generate a secret..."
						required
						style={{ flex: 1 }}
						readOnly={state.webhookSecretConfirmed}
					/>
					<button
						type="button"
						className="action-btn"
						style={{ background: "var(--yellow)", color: "#000", whiteSpace: "nowrap" }}
						onClick={onGenerateSecret}
						disabled={loading}
					>
						{loading ? "Generating..." : "Generate"}
					</button>
				</div>
				<span className="setting-description">Minimum 128 characters. Used to verify GitHub webhook signatures.</span>
			</div>

			{state.webhookSecret.length > 0 && (
				<div
					style={{
						background: "var(--bg)",
						border: "1px solid var(--border)",
						borderRadius: "6px",
						padding: "1rem",
						fontSize: "0.875rem",
						lineHeight: 1.6,
					}}
				>
					<strong>How to configure this secret in GitHub:</strong>
					<ol style={{ marginLeft: "1.25rem", marginTop: "0.5rem" }}>
						<li>Go to your repository on GitHub.</li>
						<li>Click <strong>Settings</strong> → <strong>Webhooks</strong>.</li>
						<li>Click <strong>Add webhook</strong>.</li>
						<li>Set <strong>Payload URL</strong> to your TARS webhook endpoint.</li>
						<li>Paste the secret above into <strong>Secret</strong>.</li>
						<li>Select <strong>Let me select individual events</strong> and enable <strong>Issues</strong> and <strong>Issue comments</strong>.</li>
						<li>Click <strong>Add webhook</strong>.</li>
					</ol>
					<div style={{ marginTop: "0.75rem" }}>
						<label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
							<input
								type="checkbox"
								checked={state.webhookSecretConfirmed}
								onChange={(e) => updateField("webhookSecretConfirmed", e.target.checked)}
							/>
							<span>I have configured the webhook secret in my GitHub repository settings.</span>
						</label>
					</div>
				</div>
			)}
		</div>
	);
}

function StepFourWorkspaceInit({
	state,
	onFetchRepos,
	onToggleRepo,
	onFinish,
	loading,
}: {
	state: WizardState;
	updateField: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
	onFetchRepos: () => Promise<void>;
	onToggleRepo: (index: number) => void;
	onFinish: () => Promise<void>;
	loading: boolean;
}): React.ReactElement {
	const selectedCount = state.repositories.filter((r) => r.selected).length;

	return (
		<div className="onboarding-form">
			<div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
				<button
					type="button"
					className="action-btn"
					style={{ background: "var(--blue)", color: "#000" }}
					onClick={onFetchRepos}
					disabled={loading || !state.githubToken.trim()}
				>
					{loading && state.repositories.length === 0 ? "Fetching..." : "Fetch Repositories"}
				</button>
				<span style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
					{selectedCount > 0 && `${selectedCount} selected`}
				</span>
			</div>

			{state.repositories.length > 0 && (
				<div
					style={{
						background: "var(--bg)",
						border: "1px solid var(--border)",
						borderRadius: "6px",
						padding: "1rem",
						maxHeight: "16rem",
						overflowY: "auto",
					}}
				>
					<div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
						<div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
							<input
								type="checkbox"
								checked={state.repositories.every((r) => r.selected)}
								onChange={() => {
									const allSelected = state.repositories.every((r) => r.selected);
									state.repositories.forEach((_, i) => {
										// We'll handle this via a helper in parent, but here we just toggle each
									});
								}}
								style={{ display: "none" }}
							/>
							<button
								type="button"
								className="action-btn"
								style={{
									background: "var(--surface)",
									border: "1px solid var(--border)",
									color: "var(--text)",
									fontSize: "0.75rem",
									padding: "0.25rem 0.5rem",
								}}
								onClick={() => {
									const allSelected = state.repositories.every((r) => r.selected);
									state.repositories.forEach((_, i) => {
										if (allSelected || !state.repositories[i].selected) {
											onToggleRepo(i);
										}
									});
									if (allSelected) {
										state.repositories.forEach((_, i) => onToggleRepo(i));
									}
								}}
							>
								{state.repositories.every((r) => r.selected) ? "Deselect All" : "Select All"}
							</button>
						</div>
						{state.repositories.map((repo, i) => (
							<label
								key={repo.fullName}
								style={{
									display: "flex",
									alignItems: "center",
									gap: "0.5rem",
									cursor: "pointer",
									padding: "0.35rem 0",
									borderBottom: "1px solid var(--border)",
								}}
							>
								<input
									type="checkbox"
									checked={repo.selected}
									onChange={() => onToggleRepo(i)}
								/>
								<span style={{ fontSize: "0.875rem" }}>{repo.fullName}</span>
							</label>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
