import React, { useCallback, useState } from "react";
import { submitOnboarding } from "../../api/onboarding.js";

export function OnboardingWizard(): React.ReactElement {
	const [form, setForm] = useState({
		github_token: "",
		github_username: "",
		webhook_secret: "",
		admin_username: "",
		admin_password: "",
	});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);

	const handleChange = useCallback((key: string, value: string) => {
		setForm((prev) => ({ ...prev, [key]: value }));
	}, []);

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			setSaving(true);
			setError(null);
			try {
				await submitOnboarding(form);
				setDone(true);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setSaving(false);
			}
		},
		[form],
	);

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
				<h1>Welcome to TARS</h1>
				<p className="onboarding-subtitle">
					A few required settings are missing. Fill them in below to get started.
				</p>
				{error && <div className="error-banner">{error}</div>}
				<form className="onboarding-form" onSubmit={handleSubmit}>
					<div className="form-group">
						<label htmlFor="github_token">GitHub Token</label>
						<input
							id="github_token"
							type="password"
							value={form.github_token}
							onChange={(e) => handleChange("github_token", e.target.value)}
							placeholder="ghp_..."
							required
						/>
						<span className="setting-description">Personal access token for GitHub API access</span>
					</div>
					<div className="form-group">
						<label htmlFor="github_username">GitHub Username</label>
						<input
							id="github_username"
							type="text"
							value={form.github_username}
							onChange={(e) => handleChange("github_username", e.target.value)}
							placeholder="tars-bot"
							required
						/>
						<span className="setting-description">Username for this TARS instance</span>
					</div>
					<div className="form-group">
						<label htmlFor="webhook_secret">Webhook Secret</label>
						<input
							id="webhook_secret"
							type="password"
							value={form.webhook_secret}
							onChange={(e) => handleChange("webhook_secret", e.target.value)}
							placeholder="shh..."
							required
						/>
						<span className="setting-description">GitHub webhook HMAC secret</span>
					</div>
					<div className="form-group">
						<label htmlFor="admin_username">Admin Username</label>
						<input
							id="admin_username"
							type="text"
							value={form.admin_username}
							onChange={(e) => handleChange("admin_username", e.target.value)}
							placeholder="admin"
							required
						/>
						<span className="setting-description">Username for the admin dashboard</span>
					</div>
					<div className="form-group">
						<label htmlFor="admin_password">Admin Password</label>
						<input
							id="admin_password"
							type="password"
							value={form.admin_password}
							onChange={(e) => handleChange("admin_password", e.target.value)}
							placeholder="••••••"
							required
						/>
						<span className="setting-description">Password for the admin dashboard</span>
					</div>
					<button className="action-btn restart" type="submit" disabled={saving}>
						{saving ? "Saving..." : "Save and Finish"}
					</button>
				</form>
			</div>
		</div>
	);
}

