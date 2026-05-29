import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendJson, sendText } from "./response-helpers.js";

const SESSION_COOKIE_NAME = "tars_admin_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

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

function sessionSignature(username: string, password: string, expiresAt: number): string {
	return createHmac("sha256", password).update(`${username}:${expiresAt}`).digest("base64url");
}

function buildSessionCookieValue(username: string, password: string, expiresAt: number): string {
	const payload = JSON.stringify({
		username,
		expiresAt,
		signature: sessionSignature(username, password, expiresAt),
	});
	return Buffer.from(payload, "utf8").toString("base64url");
}

function verifySessionCookie(request: IncomingMessage, username: string, password: string): boolean {
	const cookies = parseCookies(request);
	const token = cookies.get(SESSION_COOKIE_NAME);
	if (!token) {
		return false;
	}

	let parsed: { username?: string; expiresAt?: unknown; signature?: string };
	try {
		parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
			username?: string;
			expiresAt?: unknown;
			signature?: string;
		};
	} catch {
		return false;
	}

	if (parsed.username !== username || typeof parsed.signature !== "string" || typeof parsed.expiresAt !== "number") {
		return false;
	}
	if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Math.floor(Date.now() / 1000)) {
		return false;
	}

	const expected = sessionSignature(username, password, parsed.expiresAt);
	const actual = parsed.signature;
	if (actual.length !== expected.length) {
		return false;
	}

	return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function setSessionCookie(
	request: IncomingMessage,
	response: ServerResponse,
	username: string,
	password: string,
): void {
	const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
	const token = buildSessionCookieValue(username, password, expiresAt);
	const secure = isSecureRequest(request) ? "; Secure" : "";
	response.setHeader(
		"Set-Cookie",
		`${SESSION_COOKIE_NAME}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`,
	);
}

function hasValidBasicAuth(request: IncomingMessage, username: string, password: string): boolean {
	const authHeader = request.headers.authorization;
	if (!authHeader || !authHeader.startsWith("Basic ")) {
		return false;
	}

	const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
	const colonIndex = decoded.indexOf(":");
	const providedUser = colonIndex >= 0 ? decoded.slice(0, colonIndex) : decoded;
	const providedPass = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : "";
	if (providedUser.length !== username.length || providedPass.length !== password.length) {
		return false;
	}

	const userMatch = timingSafeEqual(Buffer.from(providedUser), Buffer.from(username));
	const passMatch = timingSafeEqual(Buffer.from(providedPass), Buffer.from(password));
	return userMatch && passMatch;
}

export function isAdminAuthorized(
	request: IncomingMessage,
	username: string,
	password: string,
): boolean {
	return verifySessionCookie(request, username, password) || hasValidBasicAuth(request, username, password);
}

function checkAdminAuth(
	request: IncomingMessage,
	response: ServerResponse,
	username: string,
	password: string,
): boolean {
	if (verifySessionCookie(request, username, password)) {
		return true;
	}

	if (!request.headers.authorization) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Unauthorized");
		return false;
	}

	if (!hasValidBasicAuth(request, username, password)) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Invalid credentials");
		return false;
	}

	setSessionCookie(request, response, username, password);
	return true;
}

export function requireAdminText(
	request: IncomingMessage,
	response: ServerResponse,
	username: string | undefined,
	password: string | undefined,
): boolean {
	if (!username || !password) {
		sendText(response, 404, "Not found");
		return false;
	}
	return checkAdminAuth(request, response, username, password);
}

export function requireAdminJson(
	request: IncomingMessage,
	response: ServerResponse,
	username: string | undefined,
	password: string | undefined,
): boolean {
	if (!username || !password) {
		sendJson(response, 404, { error: "Not found" });
		return false;
	}
	return checkAdminAuth(request, response, username, password);
}
