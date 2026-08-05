import React, { useCallback, useState } from "react";
import { login } from "../../api/auth.js";

export function LoginScreen({ onLoggedIn }: { onLoggedIn?: () => void }): React.ReactElement {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const handleSubmit = useCallback(
		async (event: React.FormEvent) => {
			event.preventDefault();
			setLoading(true);
			setError(null);
			try {
				await login({ username: username.trim(), password });
				onLoggedIn?.();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		},
		[username, password, onLoggedIn],
	);

	return (
		<div className="onboarding-screen">
			<div className="onboarding-card">
				<h1>Yeetomatic Admin</h1>
				<p className="onboarding-subtitle">Sign in to the admin dashboard.</p>
				{error && <div className="error-banner">{error}</div>}
				<form className="onboarding-form" onSubmit={handleSubmit}>
					<div className="form-group">
						<label htmlFor="login-username">Username</label>
						<input
							id="login-username"
							type="text"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							placeholder="username"
							autoFocus
							required
						/>
					</div>
					<div className="form-group">
						<label htmlFor="login-password">Password</label>
						<input
							id="login-password"
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							placeholder="password"
							required
						/>
					</div>
					<div className="settings-actions">
						<button
							className="action-btn restart"
							type="submit"
							disabled={loading || !username.trim() || !password}
						>
							{loading ? "Signing in..." : "Sign in"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}