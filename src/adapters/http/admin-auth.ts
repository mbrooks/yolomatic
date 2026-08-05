import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendJson, sendText } from "./response-helpers.js";
import { verifyPassword, type User, type UserStore } from "../../users/store.js";

export const SESSION_COOKIE_NAME = "yeetomatic_admin_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionPayload {
	userId: string;
	expiresAt: number;
	signature: string;
}

function isSecureRequest(request: IncomingMessage): boolean {
	if ((request.socket as { encrypted?: boolean } | undefined)?.encrypted) {
		return true;
	}
	return request.headers["x-forwarded-proto"] === "https";
}

function parseCookies(request: IncomingMessage): Map<string, string> {
	const header = request.headers.cookie;
	const cookies = new Map<string, string>();
	if (!header) {
		return cookies;
	}

	for (const part of header.split(";")) {
		const trimmed = part.trim();
		const equalsIndex = trimmed.indexOf("=");
		if (equalsIndex <= 0) {
			continue;
		}
		cookies.set(trimmed.slice(0, equalsIndex), trimmed.slice(equalsIndex + 1));
	}

	return cookies;
}

function sessionSignature(secret: string, userId: string, expiresAt: number): string {
	return createHmac("sha256", secret).update(`${userId}:${expiresAt}`).digest("base64url");
}

function buildSessionCookieValue(secret: string, userId: string, expiresAt: number): string {
	const payload: SessionPayload = {
		userId,
		expiresAt,
		signature: sessionSignature(secret, userId, expiresAt),
	};
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function parseSessionToken(token: string): SessionPayload | null {
	let parsed: Partial<SessionPayload>;
	try {
		parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<SessionPayload>;
	} catch {
		return null;
	}
	if (
		typeof parsed.userId !== "string" ||
		typeof parsed.expiresAt !== "number" ||
		typeof parsed.signature !== "string"
	) {
		return null;
	}
	return parsed as SessionPayload;
}

/**
 * Admin session authentication backed by the `users` table.
 *
 * The session cookie (`yeetomatic_admin_session`) is a signed token whose
 * payload carries `userId` and `expiresAt`, signed with an HMAC keyed by the
 * user's current password hash. This lets the server distinguish multiple
 * admin users and invalidates outstanding sessions when a password is reset
 * — without ever storing or logging plaintext passwords. HTTP Basic Auth is
 * not supported.
 */
export class AdminSessionAuth {
	constructor(private readonly userStore: UserStore) {}

	get store(): UserStore {
		return this.userStore;
	}

	/**
	 * Verify submitted credentials against the `users` table. Returns the
	 * matching user on success, or null for an unknown user or bad password.
	 */
	verifyCredentials(username: string, password: string): User | null {
		const user = this.userStore.getByUsernameSync(username);
		if (!user) {
			return null;
		}
		if (!verifyPassword(password, user.passwordHash)) {
			return null;
		}
		return user;
	}

	/** True when at least one admin user exists (boot is past onboarding). */
	hasUsers(): boolean {
		return this.userStore.hasAnySync();
	}

	/** Resolve the authenticated user for a request, or null when unauthenticated. */
	verifyRequest(request: IncomingMessage): User | null {
		const cookies = parseCookies(request);
		const token = cookies.get(SESSION_COOKIE_NAME);
		if (!token) {
			return null;
		}
		const payload = parseSessionToken(token);
		if (!payload) {
			return null;
		}
		if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Math.floor(Date.now() / 1000)) {
			return null;
		}
		const user = this.userStore.getByIdSync(payload.userId);
		if (!user) {
			return null;
		}
		const expected = sessionSignature(user.passwordHash, payload.userId, payload.expiresAt);
		const actual = payload.signature;
		if (actual.length !== expected.length) {
			return null;
		}
		if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
			return null;
		}
		return user;
	}

	/** Issue a session cookie for `user` on the outbound response. */
	setSessionCookie(request: IncomingMessage, response: ServerResponse, user: User): void {
		const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
		const token = buildSessionCookieValue(user.passwordHash, user.id, expiresAt);
		const secure = isSecureRequest(request) ? "; Secure" : "";
		response.setHeader(
			"Set-Cookie",
			`${SESSION_COOKIE_NAME}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`,
		);
	}

	/** Clear the session cookie on the outbound response. */
	clearSessionCookie(response: ServerResponse): void {
		response.setHeader(
			"Set-Cookie",
			`${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
		);
	}

	/** Issue a session cookie and return the user view, or null on bad creds. */
	login(
		request: IncomingMessage,
		response: ServerResponse,
		username: string,
		password: string,
	): User | null {
		const user = this.verifyCredentials(username, password);
		if (!user) {
			return null;
		}
		this.setSessionCookie(request, response, user);
		return user;
	}

	/** Authorize a JSON API request; sends a 401 JSON response when unauthenticated. */
	requireAdminJson(request: IncomingMessage, response: ServerResponse): boolean {
		const user = this.verifyRequest(request);
		if (user) {
			return true;
		}
		sendJson(response, 401, { error: "Unauthorized" });
		return false;
	}

	/** Authorize a text/HTML request; sends a 401 text response when unauthenticated. */
	requireAdminText(request: IncomingMessage, response: ServerResponse): boolean {
		const user = this.verifyRequest(request);
		if (user) {
			return true;
		}
		sendText(response, 401, "Unauthorized");
		return false;
	}

	/** Sync authorization check used by the WebSocket upgrade handler. */
	isAdminAuthorized(request: IncomingMessage): boolean {
		return this.verifyRequest(request) !== null;
	}
}