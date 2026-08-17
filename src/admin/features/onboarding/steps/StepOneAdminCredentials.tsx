import React, { useState } from "react";
import { generatePassword, type UpdateField, type WizardState } from "../wizard-state.js";

export interface StepOneAdminCredentialsProps {
	state: WizardState;
	updateField: UpdateField;
	onGeneratePassword: () => void;
}

export function StepOneAdminCredentials({
	state,
	updateField,
	onGeneratePassword,
}: StepOneAdminCredentialsProps): React.ReactElement {
	const [showPassword, setShowPassword] = useState(true);

	return (
		<div className="onboarding-form">
			<div className="form-group">
				<label htmlFor="admin_full_name">Admin Full Name</label>
				<input
					id="admin_full_name"
					type="text"
					value={state.adminFullName}
					onChange={(e) => updateField("adminFullName", e.target.value)}
					placeholder="Ada Lovelace"
					required
				/>
				<span className="setting-description">Full name for the master admin account</span>
			</div>
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
						onChange={(e) => {
							updateField("adminPassword", e.target.value);
							if (state.adminPasswordProtected) updateField("adminPasswordProtected", false);
						}}
						placeholder={state.adminPasswordProtected ? "Leave unchanged (configured)" : "password"}
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
				<span className="setting-description">{state.adminPasswordProtected ? "A password is already configured. Leave the field blank to keep it, or enter a new one to replace it." : "A strong password has been suggested. You may override it."}</span>
			</div>
		</div>
	);
}