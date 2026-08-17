import React, { useState } from "react";
import {
	EVENT_MODE_OPTIONS,
	MIN_POLL_INTERVAL_MS,
	DEFAULT_POLL_INTERVAL_MS,
	isPollingMode,
	isWebhookMode,
	parsePollIntervalMs,
} from "../../../../domain/onboarding/policy.js";
import { Modal } from "../../../components/Modal.js";
import type { UpdateField, WizardState } from "../wizard-state.js";

export interface StepThreeEventModeProps {
	state: WizardState;
	updateField: UpdateField;
	onGenerateSecret: () => Promise<void>;
	loading: boolean;
}

export function StepThreeEventMode({
	state,
	updateField,
	onGenerateSecret,
	loading,
}: StepThreeEventModeProps): React.ReactElement {
	const mode = state.githubEventMode;
	const showPollInterval = isPollingMode(mode);
	const showWebhookSecret = isWebhookMode(mode);
	const [showSecret, setShowSecret] = useState(true);
	const [showInstructions, setShowInstructions] = useState(false);
	const intervalError =
		showPollInterval && state.githubPollIntervalMs.trim().length > 0
			? parsePollIntervalMs(state.githubPollIntervalMs) === null
				? `Polling interval must be a whole number of at least ${MIN_POLL_INTERVAL_MS} ms.`
				: null
			: null;

	return (
		<div className="onboarding-form">
			<div className="form-group">
				<label htmlFor="github_event_mode">GitHub Event Mode</label>
				<select
					id="github_event_mode"
					value={mode}
					onChange={(e) => {
						const next = e.target.value;
						updateField("githubEventMode", next);
						if (isPollingMode(next) && !state.githubPollIntervalMs.trim()) {
							updateField("githubPollIntervalMs", String(DEFAULT_POLL_INTERVAL_MS));
						}
					}}
				>
					<option value="" disabled>Select an option…</option>
					{EVENT_MODE_OPTIONS.map((option) => (
						<option key={option} value={option}>
							{option === "webhook" ? "Webhook" : option === "polling" ? "Polling" : "Both"}
						</option>
					))}
				</select>
				<span className="setting-description">Choose how Yolomatic discovers GitHub events.</span>
				<span className="setting-description">These are the default settings for all projects. Each project can override them later.</span>
			</div>

			{showPollInterval && (
				<div className="form-group">
					<label htmlFor="github_poll_interval_ms">Polling Interval (ms)</label>
					<input
						id="github_poll_interval_ms"
						type="number"
						min={MIN_POLL_INTERVAL_MS}
						step={1000}
						value={state.githubPollIntervalMs}
						onChange={(e) => updateField("githubPollIntervalMs", e.target.value)}
						placeholder={`at least ${MIN_POLL_INTERVAL_MS}`}
						required
					/>
					<span className="setting-description">
						Positive integer in milliseconds. Minimum {MIN_POLL_INTERVAL_MS} ms.
					</span>
					{intervalError && (
						<span style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{intervalError}</span>
					)}
				</div>
			)}

			{showWebhookSecret && (
				<div className="form-group">
					<label htmlFor="webhook_secret">Webhook Secret</label>
					<div style={{ display: "flex", gap: "0.5rem" }}>
						<input
							id="webhook_secret"
							type={showSecret ? "text" : "password"}
							value={state.webhookSecret}
							onChange={(e) => {
								updateField("webhookSecret", e.target.value);
								if (state.webhookSecretProtected) updateField("webhookSecretProtected", false);
							}}
							placeholder={state.webhookSecretProtected ? "Leave unchanged (configured)" : "Generate a secret..."}
							required
							style={{ flex: 1 }}
						/>
						<button
							type="button"
							className="action-btn"
							style={{ background: "var(--yellow)", color: "#000", whiteSpace: "nowrap" }}
							onClick={onGenerateSecret}
							disabled={loading}
						>
							{loading ? "Generating..." : "Regenerate"}
						</button>
					</div>
					<div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.35rem" }}>
						<label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.875rem", color: "var(--muted)" }}>
							<input
								type="checkbox"
								checked={showSecret}
								onChange={(e) => setShowSecret(e.target.checked)}
							/>
							Show secret
						</label>
					</div>
					<span className="setting-description">Used to verify GitHub webhook signatures.</span>
					<button
						type="button"
						className="action-btn"
						style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", marginTop: "0.5rem" }}
						onClick={() => setShowInstructions(true)}
					>
						How do I configure this secret in GitHub?
					</button>
				</div>
			)}

			{mode === "polling" && (
				<p className="setting-description">No webhook secret is required for polling-only mode.</p>
			)}

			<Modal open={showInstructions} onClose={() => setShowInstructions(false)} title="Configure the webhook secret in GitHub">
				<ol style={{ marginLeft: "1.25rem", lineHeight: 1.6 }}>
					<li>Go to your repository on GitHub.</li>
					<li>Click <strong>Settings</strong> then <strong>Webhooks</strong>.</li>
					<li>Click <strong>Add webhook</strong>.</li>
					<li>Set <strong>Payload URL</strong> to your Yolomatic webhook endpoint. Example: `https://your-host.example/webhook`</li>
					<li>Set <strong>Content Type:</strong>`application/json`</li>
					<li>Paste the secret above into <strong>Secret</strong>.</li>
					<li>Select <strong>Let me select individual events</strong> and enable <strong>Issues</strong>, <strong>Issue Comments</strong>, <strong>Pull Request Reviews</strong>, and <strong>Pull Request Review Comments</strong>.</li>
					<li>Click <strong>Add webhook</strong>.</li>
				</ol>
			</Modal>
		</div>
	);
}