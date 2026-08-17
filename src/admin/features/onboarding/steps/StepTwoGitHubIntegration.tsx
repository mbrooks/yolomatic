import React from "react";
import type { UpdateField, WizardState } from "../wizard-state.js";

export interface StepTwoGitHubIntegrationProps {
	state: WizardState;
	updateField: UpdateField;
	onVerifyToken: () => Promise<void>;
	loading: boolean;
}

export function StepTwoGitHubIntegration({
	state,
	updateField,
	onVerifyToken,
	loading,
}: StepTwoGitHubIntegrationProps): React.ReactElement {
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
							if (state.githubTokenProtected) updateField("githubTokenProtected", false);
						}}
						placeholder={state.githubTokenProtected ? "Leave unchanged (configured)" : "ghp_..."}
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