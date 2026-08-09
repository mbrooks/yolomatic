import { AuthStorage, type OAuthCredential } from "@earendil-works/pi-coding-agent";

/**
 * pi auth.json provider id for ChatGPT Plus/Pro (Codex OAuth). Matches the
 * built-in `openaiCodexOAuthProvider.id` used by `AuthStorage.login`.
 */
export const OPENAI_CODEX_AUTH_PROVIDER_ID = "openai-codex";

/** Sign-in status shape returned to the admin UI / onboarding wizard. */
export interface OpenAICodexSignInResult {
	signedIn: boolean;
	/** Present when a login is in flight, so the UI can re-show the auth URL. */
	signInUrl?: string;
	/** True while a login attempt is awaiting the browser callback. */
	pending?: boolean;
	/** ChatGPT account id once signed in (when available). */
	account?: string;
	/** True when stored credentials exist but the access token has expired. */
	expired?: boolean;
	message: string;
}

/**
 * Runs the OpenAI Codex OAuth login flow. The default implementation drives
 * `AuthStorage.login` (which runs pi's built-in `openaiCodexOAuthProvider`
 * callback-server flow and persists the resulting credentials to `auth.json`).
 * Injectable so tests can simulate the flow without network or a local HTTP
 * callback server.
 */
export type OpenAICodexLoginFlow = (callbacks: {
	onAuthUrl: (url: string) => void;
	onProgress?: (message: string) => void;
}) => Promise<OAuthCredential>;

export interface OpenAICodexAuthServiceOptions {
	authStorage: AuthStorage;
	/** Overrides the login flow (testing / non-default providers). */
	loginFlow?: OpenAICodexLoginFlow;
	/** Injectable clock for expiry checks. Defaults to `Date.now`. */
	clock?: () => number;
}

/**
 * Control-plane-side service that runs the ChatGPT Plus/Pro Codex OAuth flow
 * and reports its status to the admin UI. The flow is Node `http`-callback
 * based (see pi's `openaiCodexOAuthProvider`), so it cannot run in the browser;
 * this service runs it on the control plane, surfaces the auth URL to the UI,
 * and persists the resulting OAuth credentials to `auth.json` on the shared
 * `yolomatic_pi` volume so disposable worker containers can read and refresh
 * them (see `design/architecture.md`).
 */
export class OpenAICodexAuthService {
	private readonly authStorage: AuthStorage;
	private readonly loginFlow: OpenAICodexLoginFlow;
	private readonly clock: () => number;
	private pending: { url: string; promise: Promise<void> } | null = null;

	constructor(options: OpenAICodexAuthServiceOptions) {
		this.authStorage = options.authStorage;
		this.loginFlow = options.loginFlow ?? createDefaultLoginFlow(options.authStorage);
		this.clock = options.clock ?? (() => Date.now());
	}

	/** Current sign-in status, without refreshing OAuth tokens. */
	getSignInStatus(): OpenAICodexSignInResult {
		if (this.pending) {
			return {
				signedIn: false,
				pending: true,
				signInUrl: this.pending.url,
				message: "Sign-in in progress. Open the ChatGPT authorization URL to complete login.",
			};
		}
		const credential = this.authStorage.get(OPENAI_CODEX_AUTH_PROVIDER_ID);
		if (!credential || credential.type !== "oauth") {
			return { signedIn: false, message: "Not signed in with ChatGPT." };
		}
		const expired = this.clock() >= credential.expires;
		return {
			signedIn: true,
			account: typeof credential.accountId === "string" ? credential.accountId : undefined,
			expired,
			message: expired
				? "Signed in, but the access token has expired. Workers will refresh it on the next request."
				: "Signed in with ChatGPT.",
		};
	}

	/**
	 * Starts the OAuth flow and resolves with the ChatGPT authorization URL the
	 * operator must open. The login continues in the background; credentials
	 * are persisted to `auth.json` once the browser callback completes. Calling
	 * `beginLogin` again while a flow is in flight returns the same URL.
	 */
	async beginLogin(): Promise<{ authUrl: string }> {
		if (this.pending) {
			return { authUrl: this.pending.url };
		}
		let resolveUrl!: (url: string) => void;
		let rejectUrl!: (error: Error) => void;
		const urlPromise = new Promise<string>((resolve, reject) => {
			resolveUrl = resolve;
			rejectUrl = reject;
		});
		let urlCaptured = false;
		const loginPromise = this.loginFlow({
			onAuthUrl: (url) => {
				urlCaptured = true;
				resolveUrl(url);
			},
		});
		loginPromise.catch((error) => {
			if (!urlCaptured) {
				rejectUrl(error instanceof Error ? error : new Error(String(error)));
			}
		});
		const authUrl = await urlPromise;
		this.pending = {
			url: authUrl,
			promise: loginPromise
				.then(() => {
					this.pending = null;
				})
				.catch(() => {
					this.pending = null;
				}),
		};
		return { authUrl };
	}

	/** Removes stored ChatGPT credentials and cancels any in-flight login. */
	logout(): void {
		this.pending = null;
		this.authStorage.logout(OPENAI_CODEX_AUTH_PROVIDER_ID);
	}
}

/**
 * Default login flow: drives pi's built-in `openaiCodexOAuthProvider` via
 * `AuthStorage.login`, which runs the local callback server and persists the
 * resulting OAuth credentials to `auth.json`. Manual code-paste prompts are
 * rejected because the control plane is non-interactive.
 */
export function createDefaultLoginFlow(authStorage: AuthStorage): OpenAICodexLoginFlow {
	return async (callbacks) => {
		await authStorage.login(OPENAI_CODEX_AUTH_PROVIDER_ID, {
			onAuth: (info) => callbacks.onAuthUrl(info.url),
			onDeviceCode: () => {
				// OpenAI Codex uses a callback server, not a device-code flow.
			},
			onPrompt: async () => {
				throw new Error(
					"OpenAI Codex login requires the browser callback flow; manual code entry is not supported by the control plane.",
				);
			},
			onSelect: async () => undefined,
			onProgress: callbacks.onProgress,
		});
		const credential = authStorage.get(OPENAI_CODEX_AUTH_PROVIDER_ID);
		if (!credential || credential.type !== "oauth") {
			throw new Error("OpenAI Codex login completed but no OAuth credentials were persisted.");
		}
		return credential;
	};
}