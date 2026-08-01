import http from "node:http";
import { describe, expect, it } from "vitest";

import { requireAdminJson, requireAdminText } from "./admin-auth.js";

type TestResponse = http.ServerResponse<http.IncomingMessage> & {
	headers: Record<string, string>;
	body?: string;
};

function createResponse(): TestResponse {
	const response = {
		statusCode: 200,
		headersSent: false,
		headers: {} as Record<string, string>,
		body: undefined as string | undefined,
		setHeader(this: { headers: Record<string, string> }, name: string, value: string) {
			this.headers[name.toLowerCase()] = value;
			return this;
		},
		getHeader(this: { headers: Record<string, string> }, name: string) {
			return this.headers[name.toLowerCase()];
		},
		end(this: { body?: string; headersSent: boolean }, body?: string) {
			this.body = body;
			this.headersSent = true;
			return this;
		},
	};
	return response as unknown as TestResponse;
}

function createRequest(headers: http.IncomingHttpHeaders): http.IncomingMessage {
	return {
		headers,
		socket: {},
	} as unknown as http.IncomingMessage;
}

describe("requireAdminText", () => {
	it("sets a session cookie after successful basic auth", () => {
		const request = createRequest({
			authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
			"x-forwarded-proto": "https",
		});
		const response = createResponse();

		expect(requireAdminText(request, response, "admin", "secret")).toBe(true);
		expect(response.getHeader("set-cookie")).toContain("yeetomatic_admin_session=");
		expect(response.getHeader("set-cookie")).toContain("HttpOnly");
		expect(response.getHeader("set-cookie")).toContain("Secure");
	});

	it("marks the session cookie secure for encrypted requests without forwarded proto", () => {
		const request = createRequest({
			authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
		});
		Object.assign(request.socket, { encrypted: true });
		const response = createResponse();

		expect(requireAdminText(request, response, "admin", "secret")).toBe(true);
		expect(response.getHeader("set-cookie")).toContain("Secure");
	});

	it("accepts a valid session cookie without re-sending basic auth", () => {
		const firstRequest = createRequest({
			authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
		});
		const firstResponse = createResponse();
		expect(requireAdminText(firstRequest, firstResponse, "admin", "secret")).toBe(true);

		const cookieHeader = String(firstResponse.getHeader("set-cookie")).split(";")[0];
		const secondRequest = createRequest({
			cookie: cookieHeader,
		});
		const secondResponse = createResponse();

		expect(requireAdminText(secondRequest, secondResponse, "admin", "secret")).toBe(true);
		expect(secondResponse.statusCode).toBe(200);
		expect(secondResponse.getHeader("www-authenticate")).toBeUndefined();
	});

	it("rejects requests without valid cookie or basic auth", () => {
		const request = createRequest({
			cookie: "yeetomatic_admin_session=invalid",
		});
		const response = createResponse();

		expect(requireAdminText(request, response, "admin", "secret")).toBe(false);
		expect(response.statusCode).toBe(401);
		expect(response.body).toBe("Unauthorized");
	});

	it("rejects invalid basic auth with an explicit invalid-credentials response", () => {
		const request = createRequest({
			authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}`,
		});
		const response = createResponse();

		expect(requireAdminText(request, response, "admin", "secret")).toBe(false);
		expect(response.statusCode).toBe(401);
		expect(response.body).toBe("Invalid credentials");
	});

	it("rejects malformed basic auth credentials with an explicit invalid-credentials response", () => {
		const request = createRequest({
			authorization: `Basic ${Buffer.from("admin").toString("base64")}`,
		});
		const response = createResponse();

		expect(requireAdminText(request, response, "admin", "secret")).toBe(false);
		expect(response.statusCode).toBe(401);
		expect(response.body).toBe("Invalid credentials");
	});
});

describe("requireAdminJson", () => {
	it("returns a 404 json payload when admin credentials are not configured", () => {
		const request = createRequest({});
		const response = createResponse();

		expect(requireAdminJson(request, response, undefined, undefined)).toBe(false);
		expect(response.statusCode).toBe(404);
		expect(response.getHeader("content-type")).toContain("application/json");
		expect(response.body).toBe('{"error":"Not found"}');
	});
});
