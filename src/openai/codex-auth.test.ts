import { describe, expect, it, vi } from "vitest";
import { AuthStorage, type OAuthCredential } from "@earendil-works/pi-coding-agent";
import {
	OpenAICodexAuthService,
	OPENAI_CODEX_AUTH_PROVIDER_ID,
	createDefaultLoginFlow,
	type OpenAICodexLoginFlow,
} from "./codex-auth.js";

function makeCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
	return {
		type: "oauth",
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 3_600_000,
		accountId: "chatgpt-user-123",
		...overrides,
	} as OAuthCredential;
}

/**
 * Builds a fake login flow that emits `url` via onAuthUrl, then resolves only
 * once the returned `resolve` callback is invoked (mirroring the real flow,
 * which waits for the browser callback). On resolve it persists `cred` to the
 * supplied AuthStorage so `getSignInStatus` observes the signed-in state.
 */
function fakeControlledLoginFlow(
	authStorage: AuthStorage,
	url: string,
	cred: OAuthCredential,
): { flow: OpenAICodexLoginFlow; resolve: () => void; reject: (error: Error) => void } {
	let resolveLogin!: () => void;
	let rejectLogin!: (error: Error) => void;
	const promise = new Promise<OAuthCredential>((resolve, reject) => {
		resolveLogin = () => {
			authStorage.set(OPENAI_CODEX_AUTH_PROVIDER_ID, cred);
			resolve(cred);
		};
		rejectLogin = reject;
	});
	const flow = vi.fn((callbacks: { onAuthUrl: (url: string) => void }) => {
		callbacks.onAuthUrl(url);
		return promise;
	}) as unknown as OpenAICodexLoginFlow;
	return { flow, resolve: resolveLogin, reject: rejectLogin };
}

describe("OpenAICodexAuthService", () => {
	it("reports not signed in when no credentials are stored", () => {
		const authStorage = AuthStorage.inMemory();
		const { flow } = fakeControlledLoginFlow(authStorage, "https://x", makeCredential());
		const service = new OpenAICodexAuthService({ authStorage, loginFlow: flow });

		expect(service.getSignInStatus()).toEqual(
			expect.objectContaining({ signedIn: false }),
		);
		expect(service.getSignInStatus().pending).toBeUndefined();
	});

	it("begins login, reports pending with the auth URL, then signed in after the flow resolves", async () => {
		const authStorage = AuthStorage.inMemory();
		const cred = makeCredential();
		const { flow, resolve } = fakeControlledLoginFlow(authStorage, "https://auth.openai.com/authorize?state=abc", cred);
		const service = new OpenAICodexAuthService({ authStorage, loginFlow: flow });

		const result = await service.beginLogin();

		expect(result.authUrl).toBe("https://auth.openai.com/authorize?state=abc");
		expect(flow).toHaveBeenCalledTimes(1);
		// Pending state is visible immediately after beginLogin resolves.
		expect(service.getSignInStatus()).toEqual(
			expect.objectContaining({
				signedIn: false,
				pending: true,
				signInUrl: "https://auth.openai.com/authorize?state=abc",
			}),
		);

		resolve();
		await vi.waitFor(() => expect(service.getSignInStatus().pending).toBeUndefined());
		expect(service.getSignInStatus()).toEqual(
			expect.objectContaining({ signedIn: true, account: "chatgpt-user-123", expired: false }),
		);
	});

	it("returns the same auth URL when beginLogin is called while a flow is in flight", async () => {
		const authStorage = AuthStorage.inMemory();
		const { flow, resolve } = fakeControlledLoginFlow(authStorage, "https://auth.openai.com/authorize?state=pending", makeCredential());
		const service = new OpenAICodexAuthService({ authStorage, loginFlow: flow });

		const first = await service.beginLogin();
		const second = await service.beginLogin();

		expect(first.authUrl).toBe("https://auth.openai.com/authorize?state=pending");
		expect(second.authUrl).toBe(first.authUrl);
		expect(flow).toHaveBeenCalledTimes(1);

		resolve();
		await vi.waitFor(() => expect(service.getSignInStatus().signedIn).toBe(true));
	});

	it("surfaces a login failure that occurs before the auth URL is produced", async () => {
		const authStorage = AuthStorage.inMemory();
		const loginFlow = vi.fn(async () => {
			throw new Error("callback server failed to start");
		}) as unknown as OpenAICodexLoginFlow;
		const service = new OpenAICodexAuthService({ authStorage, loginFlow });

		await expect(service.beginLogin()).rejects.toThrow("callback server failed to start");
		expect(loginFlow).toHaveBeenCalledTimes(1);
		expect(service.getSignInStatus().pending).toBeUndefined();
	});

	it("clears the pending state when the background login rejects after the URL was produced", async () => {
		const authStorage = AuthStorage.inMemory();
		const { flow, reject } = fakeControlledLoginFlow(authStorage, "https://auth.openai.com/authorize?state=will-fail", makeCredential());
		const service = new OpenAICodexAuthService({ authStorage, loginFlow: flow });

		await service.beginLogin();
		expect(service.getSignInStatus().pending).toBe(true);

		reject(new Error("OAuth exchange failed"));
		await vi.waitFor(() => expect(service.getSignInStatus().pending).toBeUndefined());
		expect(service.getSignInStatus().signedIn).toBe(false);
	});

	it("reports expired when the stored access token is past its expiry", () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set(OPENAI_CODEX_AUTH_PROVIDER_ID, makeCredential({ expires: 1_000 }));
		const now = 5_000;
		const { flow } = fakeControlledLoginFlow(authStorage, "https://x", makeCredential());
		const service = new OpenAICodexAuthService({ authStorage, loginFlow: flow, clock: () => now });

		const status = service.getSignInStatus();
		expect(status.signedIn).toBe(true);
		expect(status.expired).toBe(true);
		expect(status.message).toContain("expired");
	});

	it("logout removes stored credentials", () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set(OPENAI_CODEX_AUTH_PROVIDER_ID, makeCredential());
		const { flow } = fakeControlledLoginFlow(authStorage, "https://x", makeCredential());
		const service = new OpenAICodexAuthService({ authStorage, loginFlow: flow });

		expect(service.getSignInStatus().signedIn).toBe(true);
		service.logout();
		expect(service.getSignInStatus().signedIn).toBe(false);
		expect(authStorage.has(OPENAI_CODEX_AUTH_PROVIDER_ID)).toBe(false);
	});

	it("createDefaultLoginFlow drives AuthStorage.login and returns the persisted credential", async () => {
		const cred = makeCredential();
		const authStorage = AuthStorage.inMemory();
		// Replace AuthStorage.login with a stub that invokes every callback
		// (mirroring the real provider without a network/callback server) so the
		// default flow's callback wiring is covered.
		const loginStub = vi.fn(async (_providerId: string, callbacks: {
			onAuth: (info: { url: string }) => void;
			onDeviceCode: () => void;
			onPrompt: () => Promise<string>;
			onSelect: () => Promise<string | undefined>;
		}) => {
			callbacks.onAuth({ url: "https://auth.openai.com/authorize?state=stub" });
			callbacks.onDeviceCode();
			await callbacks.onSelect();
			await expect(callbacks.onPrompt()).rejects.toThrow("browser callback flow");
			authStorage.set(OPENAI_CODEX_AUTH_PROVIDER_ID, cred);
		});
		(authStorage as unknown as { login: typeof loginStub }).login = loginStub;

		const flow = createDefaultLoginFlow(authStorage);
		const result = await flow({ onAuthUrl: () => {} });

		expect(loginStub).toHaveBeenCalledWith(OPENAI_CODEX_AUTH_PROVIDER_ID, expect.objectContaining({ onAuth: expect.any(Function) }));
		expect(result).toEqual(cred);
	})

	it("createDefaultLoginFlow throws when AuthStorage.login does not persist credentials", async () => {
		const authStorage = AuthStorage.inMemory();
		const loginStub = vi.fn(async (_providerId: string, callbacks: { onAuth: (info: { url: string }) => void }) => {
			callbacks.onAuth({ url: "https://auth.openai.com/authorize?state=stub" });
		});
		(authStorage as unknown as { login: typeof loginStub }).login = loginStub;

		const flow = createDefaultLoginFlow(authStorage);
		await expect(flow({ onAuthUrl: () => {} })).rejects.toThrow("no OAuth credentials were persisted");
	});
});