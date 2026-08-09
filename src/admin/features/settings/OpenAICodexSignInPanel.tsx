import React, { useCallback, useEffect, useState } from "react";
import {
	fetchOpenAICodexStatus,
	beginOpenAICodexLogin,
	logoutOpenAICodex,
	type OpenAICodexSignInStatus,
} from "../../api/openai-codex.js";

/** Fetcher signatures shared by the Settings-screen and onboarding callers. */
export type FetchOpenAICodexStatus = () => Promise<OpenAICodexSignInStatus>;
export type BeginOpenAICodexLogin = () => Promise<{ authUrl: string }>;
export type LogoutOpenAICodex = () => Promise<{ success: boolean }>;

/**
 * Surfaces the ChatGPT Plus/Pro Codex OAuth sign-in state. The OAuth flow runs
 * on the control plane (it is Node `http`-callback based and cannot run in the
 * browser), so this panel asks the control plane to begin the flow, opens the
 * returned authorization URL in a new tab, and polls status until the
 * callback completes and credentials are persisted.
 *
 * Fetchers are injectable so the onboarding wizard can pass the
 * onboarding-scoped endpoints (reachable before any admin session exists)
 * without changing the Settings-screen behavior, which defaults to the
 * authed `/api/openai-codex/*` endpoints.
 */
export function OpenAICodexSignInPanel({
	fetchStatus = fetchOpenAICodexStatus,
	beginLogin = beginOpenAICodexLogin,
	logout = logoutOpenAICodex,
}: {
	fetchStatus?: FetchOpenAICodexStatus;
	beginLogin?: BeginOpenAICodexLogin;
	logout?: LogoutOpenAICodex;
}): React.ReactElement {
	const [status, setStatus] = useState<OpenAICodexSignInStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await fetchStatus();
			setStatus(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatus(null);
		} finally {
			setLoading(false);
		}
	}, [fetchStatus]);

	useEffect(() => {
		void load();
	}, [load]);

	const handleSignIn = useCallback(async () => {
		setStarting(true);
		setError(null);
		try {
			const result = await beginLogin();
			if (result.authUrl) {
				window.open(result.authUrl, "_blank", "noopener,noreferrer");
			}
			// Re-check status; the callback may complete quickly or take a while.
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setStarting(false);
		}
	}, [beginLogin, load]);

	const handleLogout = useCallback(async () => {
		try {
			await logout();
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [logout, load]);

	return (
		<section className="ollama-signin-panel" aria-label="ChatGPT Codex sign-in status">
			<div className="ollama-signin-panel__header">
				<h3 className="ollama-signin-panel__title">ChatGPT (Codex) sign-in status</h3>
				<button className="action-btn" onClick={() => void load()} disabled={loading} type="button">
					{loading ? "Checking..." : "Re-check status"}
				</button>
			</div>

			{error && (
				<div className="error-banner" role="alert">
					{error}
				</div>
			)}

			{loading && !status && !error && (
				<div className="ollama-signin-panel__status">Checking ChatGPT sign-in status...</div>
			)}

			{status && (
				<div className="ollama-signin-panel__status" data-signed-in={status.signedIn ? "true" : "false"}>
					{status.signedIn ? (
						<>
							<p className="ollama-signin-panel__signed-in">
								Signed in{status.account ? <> as <strong>{status.account}</strong></> : null}.
								{status.expired ? " Access token expired; workers will refresh it." : ""}
							</p>
							<button
								className="action-btn"
								style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", marginTop: "0.5rem" }}
								onClick={() => void handleLogout()}
								type="button"
							>
								Sign out
							</button>
						</>
					) : status.pending ? (
						<>
							<p className="ollama-signin-panel__not-signed-in">Authorization in progress.</p>
							{status.signInUrl ? (
								<p className="ollama-signin-panel__instruction">
									Open the ChatGPT authorization URL if your browser did not open automatically:{" "}
									<a href={status.signInUrl} target="_blank" rel="noopener noreferrer">
										{status.signInUrl}
									</a>
								</p>
							) : null}
						</>
					) : (
						<>
							<p className="ollama-signin-panel__not-signed-in">Not signed in with ChatGPT.</p>
							<button
								className="action-btn"
								style={{ background: "var(--blue)", color: "#000", marginTop: "0.5rem" }}
								onClick={() => void handleSignIn()}
								disabled={starting}
								type="button"
							>
								{starting ? "Starting..." : "Sign in with ChatGPT"}
							</button>
							<span className="setting-description" style={{ display: "block", marginTop: "0.35rem" }}>
								Runs the ChatGPT OAuth flow on the control plane. OpenAI Codex workers read the
								resulting credentials from the shared pi auth volume.
							</span>
						</>
					)}
				</div>
			)}
		</section>
	);
}