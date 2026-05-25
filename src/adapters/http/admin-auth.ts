import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendJson, sendText } from "./response-helpers.js";

function checkBasicAuth(
	request: IncomingMessage,
	response: ServerResponse,
	username: string,
	password: string,
): boolean {
	const authHeader = request.headers.authorization;
	if (!authHeader || !authHeader.startsWith("Basic ")) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Unauthorized");
		return false;
	}

	const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
	const colonIndex = decoded.indexOf(":");
	const providedUser = colonIndex >= 0 ? decoded.slice(0, colonIndex) : decoded;
	const providedPass = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : "";
	if (providedUser.length !== username.length || providedPass.length !== password.length) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Invalid credentials");
		return false;
	}

	const userMatch = timingSafeEqual(Buffer.from(providedUser), Buffer.from(username));
	const passMatch = timingSafeEqual(Buffer.from(providedPass), Buffer.from(password));
	if (!userMatch || !passMatch) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Invalid credentials");
		return false;
	}
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
	return checkBasicAuth(request, response, username, password);
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
	return checkBasicAuth(request, response, username, password);
}
