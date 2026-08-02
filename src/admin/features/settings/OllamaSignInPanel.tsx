import React, { useCallback, useEffect, useState } from "react";
import { fetchOllamaSignInStatus, type OllamaSignInStatus } from "../../api/ollama.js";

/**
 * Surfaces the current Ollama sign-in status on the AI / LLM settings tab.
 * Only rendered when the selected provider is Ollama. Re-checks status via
 * `GET /api/ollama/signin` without a full page reload.
 */
export function OllamaSignInPanel({ containerName = "yeetomatic-ollama" }: {
	containerName?: string;
}): React.ReactElement {
	const [status, setStatus] = useState<OllamaSignInStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await fetchOllamaSignInStatus();
			setStatus(result);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			setStatus(null);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const dockerCommand = `docker exec -it ${containerName} ollama login`;

	return (
		<section className="ollama-signin-panel" aria-label="Ollama sign-in status">
			<div className="ollama-signin-panel__header">
				<h3 className="ollama-signin-panel__title">Ollama sign-in status</h3>
				<button
					className="action-btn"
					onClick={() => void load()}
					disabled={loading}
					type="button"
				>
					{loading ? "Checking..." : "Re-check status"}
				</button>
			</div>

			{error && (
				<div className="error-banner" role="alert">
					{error}
				</div>
			)}

			{loading && !status && !error && (
				<div className="ollama-signin-panel__status">Checking Ollama sign-in status...</div>
			)}

			{status && (
				<div className="ollama-signin-panel__status" data-signed-in={status.signedIn ? "true" : "false"}>
					{status.signedIn ? (
						<p className="ollama-signin-panel__signed-in">
							Signed in as <strong>{status.user ?? "unknown"}</strong>
						</p>
					) : status.error ? (
						<p className="ollama-signin-panel__error">
							{status.error === "timeout"
								? "Could not reach the Ollama container in time."
								: "Could not reach the Ollama container."}
						</p>
					) : (
						<>
							<p className="ollama-signin-panel__not-signed-in">Not signed in.</p>
							<p className="ollama-signin-panel__instruction">
								Sign in to the Ollama site to enable Cloud models:
								{status.signInUrl ? (
									<>
										{" "}
										<a
											href={status.signInUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											{status.signInUrl}
										</a>
									</>
								) : null}
							</p>
						</>
					)}

					{!status.signedIn && !status.error && (
						<div className="ollama-signin-panel__cli">
							<p>Or run this command in a shell:</p>
							<code className="ollama-signin-panel__code">{dockerCommand}</code>
						</div>
					)}

					{status.error && (
						<p className="ollama-signin-panel__hint">
							Make sure the Ollama container is running and Docker is available to the
							control plane, then click Re-check status.
						</p>
					)}
				</div>
			)}
		</section>
	);
}