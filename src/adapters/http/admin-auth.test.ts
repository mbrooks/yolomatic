import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AdminSessionAuth, SESSION_COOKIE_NAME } from "./admin-auth.js";
import { UserStore } from "../../users/store.js";

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

async function tmpUserStore(): Promise<UserStore> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-admin-auth-"));
	const store = new UserStore(path.join(dir, "users.sqlite"));
	store.createSync({ fullName: "Admin", username: "admin", password: "secret" });
	return store;
}

function mintCookie(auth: AdminSessionAuth, username: string, password: string, request: http.IncomingMessage): string {
	const res = createResponse();
	const user = auth.login(request, res, username, password);
	if (!user) throw new Error("login failed");
	return String(res.getHeader("set-cookie")).split(";")[0];
}

describe("AdminSessionAuth", () => {
	it("verifies valid credentials and returns the user", async () => {
		const auth = new AdminSessionAuth(await tmpUserStore());
		const user = auth.verifyCredentials("admin", "secret");
		expect(user).toBeDefined();
		expect(user?.username).toBe("admin");
	});

	it("rejects an unknown user", async () => {
		const auth = new AdminSessionAuth(await tmpUserStore());
		expect(auth.verifyCredentials("ghost", "secret")).toBeNull();
	});

	it("rejects a bad password", async () => {
		const auth = new AdminSessionAuth(await tmpUserStore());
		expect(auth.verifyCredentials("admin", "wrong")).toBeNull();
	});

	it("looks up usernames case-insensitively", async () => {
		const auth = new AdminSessionAuth(await tmpUserStore());
		expect(auth.verifyCredentials("ADMIN", "secret")?.username).toBe("admin");
	});

	it("issues a session cookie on login", async () => {
		const auth = new AdminSessionAuth(await tmpUserStore());
		const request = createRequest({ "x-forwarded-proto": "https" });
		const response = createResponse();

		const user = auth.login(request, response, "admin", "secret");
		expect(user).toBeDefined();
		const cookie = String(response.getHeader("set-cookie"));
		expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Secure");
	});

	it("does not set the Secure flag for plain HTTP requests", async () => {
		const auth = new AdminSessionAuth(await tmpUserStore());
		const request = createRequest({});
		const response = createResponse();

		auth.login(request, response, "admin", "secret");
		const cookie = String(response.getHeader("set-cookie"));
		expect(cookie).not.toContain("Secure");
	});

	it("returns null for invalid login credentials without setting a cookie", async () => {
		const auth = new AdminSessionAuth(await tmpUserStore());
		const request = createRequest({});
		const response = createResponse();

		expect(auth.login(request, response, "admin", "wrong")).toBeNull();
		expect(response.getHeader("set-cookie")).toBeUndefined();
	});

	it("verifies a previously-issued session cookie", async () => {
		const auth = new AdminSessionAuth(await tmpUserStore());
		const request = createRequest({});
		const cookie = mintCookie(auth, "admin", "secret", request);

		const secondRequest = createRequest({ cookie });
		expect(auth.verifyRequest(secondRequest)?.username).toBe("admin");
	});

	it("rejects a tampered session cookie", async () => {
		const auth = new AdminSessionAuth(await tmpUserStore());
		const request = createRequest({
			cookie: `${SESSION_COOKIE_NAME}=invalid`,
		});
		expect(auth.verifyRequest(request)).toBeNull();
	});

	it("rejects an expired session cookie", async () => {
		const store = await tmpUserStore();
		const auth = new AdminSessionAuth(store);
		// Build a token signed with the user's hash but an expired timestamp.
		const user = store.getByUsernameSync("admin")!;
		const { createHmac } = await import("node:crypto");
		const expiresAt = Math.floor(Date.now() / 1000) - 10;
		const signature = createHmac("sha256", user.passwordHash).update(`${user.id}:${expiresAt}`).digest("base64url");
		const token = Buffer.from(JSON.stringify({ userId: user.id, expiresAt, signature }), "utf8").toString("base64url");
		const request = createRequest({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
		expect(auth.verifyRequest(request)).toBeNull();
	});

	it("rejects a session cookie after the password is reset", async () => {
		const store = await tmpUserStore();
		const auth = new AdminSessionAuth(store);
		const request = createRequest({});
		const cookie = mintCookie(auth, "admin", "secret", request);
		const authedRequest = createRequest({ cookie });
		expect(auth.verifyRequest(authedRequest)?.username).toBe("admin");

		store.updatePasswordSync(store.getByUsernameSync("admin")!.id, "newpass");
		expect(auth.verifyRequest(authedRequest)).toBeNull();
	});

	it("clears the session cookie on logout", async () => {
		const auth = new AdminSessionAuth(await tmpUserStore());
		const response = createResponse();
		auth.clearSessionCookie(response);
		const cookie = String(response.getHeader("set-cookie"));
		expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
		expect(cookie).toContain("Max-Age=0");
	});

	describe("requireAdminJson", () => {
		it("authorizes a request with a valid session cookie", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const request = createRequest({});
			const cookie = mintCookie(auth, "admin", "secret", request);
			const authedRequest = createRequest({ cookie });
			expect(auth.requireAdminJson(authedRequest, createResponse())).toBe(true);
		});

		it("rejects a request without a session cookie with a JSON 401", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const request = createRequest({});
			const response = createResponse();
			expect(auth.requireAdminJson(request, response)).toBe(false);
			expect(response.statusCode).toBe(401);
			expect(response.body).toContain("Unauthorized");
			expect(response.getHeader("www-authenticate")).toBeUndefined();
		});
	});

	describe("requireAdminText", () => {
		it("rejects a request without a session cookie with a text 401", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const request = createRequest({});
			const response = createResponse();
			expect(auth.requireAdminText(request, response)).toBe(false);
			expect(response.statusCode).toBe(401);
			expect(response.body).toBe("Unauthorized");
			expect(response.getHeader("www-authenticate")).toBeUndefined();
		});
	});

	describe("verifyBasicAuth", () => {
		it("returns the user for a valid Basic header", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const header = "Basic " + Buffer.from("admin:secret").toString("base64");
			expect(auth.verifyBasicAuth(createRequest({ authorization: header }))?.username).toBe("admin");
		});

		it("accepts a lowercase basic scheme", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const header = "basic " + Buffer.from("admin:secret").toString("base64");
			expect(auth.verifyBasicAuth(createRequest({ authorization: header }))?.username).toBe("admin");
		});

		it("looks up usernames case-insensitively", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const header = "Basic " + Buffer.from("ADMIN:secret").toString("base64");
			expect(auth.verifyBasicAuth(createRequest({ authorization: header }))?.username).toBe("admin");
		});

		it("rejects a bad password", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const header = "Basic " + Buffer.from("admin:wrong").toString("base64");
			expect(auth.verifyBasicAuth(createRequest({ authorization: header }))).toBeNull();
		});

		it("rejects an unknown user", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const header = "Basic " + Buffer.from("ghost:secret").toString("base64");
			expect(auth.verifyBasicAuth(createRequest({ authorization: header }))).toBeNull();
		});

		it("returns null when the Authorization header is absent", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			expect(auth.verifyBasicAuth(createRequest({}))).toBeNull();
		});

		it("returns null for a non-Basic scheme", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			expect(auth.verifyBasicAuth(createRequest({ authorization: "Bearer token" }))).toBeNull();
		});

		it("returns null for a malformed header (no credentials)", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			expect(auth.verifyBasicAuth(createRequest({ authorization: "Basic" }))).toBeNull();
		});

		it("returns null for credentials with no colon", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const header = "Basic " + Buffer.from("nocolonpassword").toString("base64");
			expect(auth.verifyBasicAuth(createRequest({ authorization: header }))).toBeNull();
		});

		it("allows a password containing a colon", async () => {
			const dir = await mkdtemp(path.join(os.tmpdir(), "yeetomatic-admin-auth-"));
			const store = new UserStore(path.join(dir, "users.sqlite"));
			store.createSync({ fullName: "Admin", username: "admin", password: "pa:ss:word" });
			const auth = new AdminSessionAuth(store);
			const header = "Basic " + Buffer.from("admin:pa:ss:word").toString("base64");
			expect(auth.verifyBasicAuth(createRequest({ authorization: header }))?.username).toBe("admin");
		});

		it("returns null for invalid base64", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			expect(auth.verifyBasicAuth(createRequest({ authorization: "Basic !!!not-base64!!!" }))).toBeNull();
		});
	});

	describe("requireAdminJsonAllowBasic", () => {
		it("authorizes a request with a valid session cookie", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const request = createRequest({});
			const cookie = mintCookie(auth, "admin", "secret", request);
			const authedRequest = createRequest({ cookie });
			expect(auth.requireAdminJsonAllowBasic(authedRequest, createResponse())).toBe(true);
		});

		it("authorizes a request with valid Basic credentials and no cookie", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const header = "Basic " + Buffer.from("admin:secret").toString("base64");
			const request = createRequest({ authorization: header });
			expect(auth.requireAdminJsonAllowBasic(request, createResponse())).toBe(true);
		});

		it("prefers the session cookie when both are present", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const loginRequest = createRequest({});
			const cookie = mintCookie(auth, "admin", "secret", loginRequest);
			const header = "Basic " + Buffer.from("admin:wrong").toString("base64");
			const request = createRequest({ cookie, authorization: header });
			expect(auth.requireAdminJsonAllowBasic(request, createResponse())).toBe(true);
		});

		it("rejects a request with neither cookie nor Basic credentials", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const request = createRequest({});
			const response = createResponse();
			expect(auth.requireAdminJsonAllowBasic(request, response)).toBe(false);
			expect(response.statusCode).toBe(401);
			expect(response.body).toContain("Unauthorized");
			expect(response.getHeader("www-authenticate")).toBeUndefined();
		});

		it("rejects a request with invalid Basic credentials", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const header = "Basic " + Buffer.from("admin:wrong").toString("base64");
			const request = createRequest({ authorization: header });
			const response = createResponse();
			expect(auth.requireAdminJsonAllowBasic(request, response)).toBe(false);
			expect(response.statusCode).toBe(401);
		});
	});

	describe("isAdminAuthorized", () => {
		it("returns true for a valid session cookie and false otherwise", async () => {
			const auth = new AdminSessionAuth(await tmpUserStore());
			const request = createRequest({});
			const cookie = mintCookie(auth, "admin", "secret", request);
			expect(auth.isAdminAuthorized(createRequest({ cookie }))).toBe(true);
			expect(auth.isAdminAuthorized(createRequest({ cookie: `${SESSION_COOKIE_NAME}=bad` }))).toBe(false);
			expect(auth.isAdminAuthorized(createRequest({}))).toBe(false);
		});
	});

	it("hasUsers reflects the user store", async () => {
		const store = await tmpUserStore();
		const auth = new AdminSessionAuth(store);
		expect(auth.hasUsers()).toBe(true);
		store.deleteSync(store.getByUsernameSync("admin")!.id);
		expect(auth.hasUsers()).toBe(false);
	});
});