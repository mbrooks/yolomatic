import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { Writable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { adminHtml, injectAdminConfig, serveAdminAsset, sendStream } from "./asset-server.js";

class MockResponse extends Writable {
	statusCode = 0;
	headers: Record<string, string> = {};
	destroyed = false;
	headersSent = false;
	chunks: Buffer[] = [];
	setHeader = (name: string, value: string): void => {
		this.headers[name] = value;
	};

	_write(chunk: Buffer, _encoding: string, callback: () => void): void {
		this.chunks.push(Buffer.from(chunk));
		callback();
	}

	get body(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

function createMockResponse(): MockResponse {
	const res = new MockResponse();
	vi.spyOn(res, "end");
	vi.spyOn(res, "destroy").mockImplementation(() => {
		res.destroyed = true;
		return res;
	});
	return res;
}

async function waitForFinish(res: MockResponse): Promise<void> {
	if (res.writableEnded || res.destroyed) return;
	await new Promise<void>((resolve) => {
		const done = (): void => resolve();
		res.once("finish", done);
		res.once("close", done);
		res.once("error", done);
		setTimeout(done, 200);
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("injectAdminConfig", () => {
	it("injects the config script before </head> when present", () => {
		const html = "<html><head><title>T</title></head><body></body></html>";
		const result = injectAdminConfig(html, "/yolomatic/admin", "#/dashboard");
		expect(result).toContain(
			'<script>window.__YOLO_ADMIN_PATH__ = "/yolomatic/admin"; window.__YOLO_ADMIN_DEFAULT_PAGE__ = "#/dashboard";</script>',
		);
		expect(result).toMatch(/<script>[^<]*<\/script><\/head>/);
	});

	it("injects after <body> when no </head> is present", () => {
		const html = "<html><body><div></div></body></html>";
		const result = injectAdminConfig(html, "/custom/admin", "#/repos");
		expect(result).toContain('window.__YOLO_ADMIN_PATH__ = "/custom/admin"');
		expect(result).toContain('window.__YOLO_ADMIN_DEFAULT_PAGE__ = "#/repos"');
		expect(result).toMatch(/<body><script>/);
	});

	it("prepends the script when neither head nor body tags are present", () => {
		const html = "plain text";
		const result = injectAdminConfig(html);
		expect(result.startsWith("<script>")).toBe(true);
		expect(result).toContain('window.__YOLO_ADMIN_PATH__ = "/yolomatic/admin"');
		expect(result).toContain('window.__YOLO_ADMIN_DEFAULT_PAGE__ = "#/dashboard"');
	});

	it("escapes quote characters in the configured values", () => {
		const result = injectAdminConfig("<head></head>", '/a"</script>', "#/x");
		expect(result).not.toContain('/a"</script>');
	});
});

describe("adminHtml", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-asset-server-"));
	});

	afterEach(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	it("reads and injects config into the built index.html", async () => {
		await writeFile(
			path.join(dir, "index.html"),
			'<!doctype html><html><head><title>Yolomatic</title></head><body><div id="root"></div></body></html>',
		);
		const html = await adminHtml(dir, "/yolomatic/admin", "#/dashboard");
		expect(html).toContain("Yolomatic");
		expect(html).toContain('window.__YOLO_ADMIN_PATH__ = "/yolomatic/admin"');
	});

	it("falls back to the fallback html when index.html is missing", async () => {
		const html = await adminHtml(path.join(dir, "missing"), "/yolomatic/admin");
		expect(html).toContain("Yolomatic Admin assets have not been built.");
		expect(html).not.toContain("__YOLO_ADMIN_PATH__");
	});
});

describe("serveAdminAsset", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "yolomatic-asset-server-assets-"));
	});

	afterEach(async () => {
		await rm(dir, { force: true, recursive: true });
	});

	it("rejects invalid URI-encoded asset paths with 400", async () => {
		const res = createMockResponse();
		await serveAdminAsset(res as unknown as http.ServerResponse, dir, "%E0%A4");
		expect(res.statusCode).toBe(400);
		expect(res.body).toBe("Invalid asset path");
	});

	it("rejects path traversal attempts with 404", async () => {
		const res = createMockResponse();
		await serveAdminAsset(res as unknown as http.ServerResponse, dir, "../../etc/passwd");
		expect(res.statusCode).toBe(404);
		expect(res.body).toBe("Not found");
	});

	it("rejects the directory root with 404", async () => {
		const res = createMockResponse();
		await serveAdminAsset(res as unknown as http.ServerResponse, dir, "");
		expect(res.statusCode).toBe(404);
		expect(res.body).toBe("Not found");
	});

	it("returns 404 for a missing file", async () => {
		const res = createMockResponse();
		await serveAdminAsset(res as unknown as http.ServerResponse, dir, "missing.js");
		expect(res.statusCode).toBe(404);
		expect(res.body).toBe("Not found");
	});

	it("returns 404 when the path resolves to a directory", async () => {
		await mkdir(path.join(dir, "subdir"));
		const res = createMockResponse();
		await serveAdminAsset(res as unknown as http.ServerResponse, dir, "subdir");
		expect(res.statusCode).toBe(404);
		expect(res.body).toBe("Not found");
	});

	it("streams an existing file with the correct content type", async () => {
		await writeFile(path.join(dir, "main.js"), "console.log('admin');");
		const res = createMockResponse();
		await serveAdminAsset(res as unknown as http.ServerResponse, dir, "main.js");
		await waitForFinish(res);
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
		expect(res.body).toBe("console.log('admin');");
	});

	it("serves css with the css content type", async () => {
		await writeFile(path.join(dir, "style.css"), "body{}");
		const res = createMockResponse();
		await serveAdminAsset(res as unknown as http.ServerResponse, dir, "style.css");
		await waitForFinish(res);
		expect(res.headers["content-type"]).toBe("text/css; charset=utf-8");
	});
});

describe("sendStream", () => {
	it("writes a 500 response when the stream errors before headers are sent", async () => {
		const res = createMockResponse();
		sendStream(
			res as unknown as http.ServerResponse,
			200,
			"text/javascript; charset=utf-8",
			path.join(os.tmpdir(), "definitely-missing-asset.js"),
		);
		await waitForFinish(res);
		expect(res.statusCode).toBe(500);
		expect(res.body).toBe("Unable to read admin asset");
	});

	it("destroys the response when the stream errors after headers are sent", async () => {
		const res = createMockResponse();
		(res as unknown as { headersSent: boolean }).headersSent = true;
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		sendStream(
			res as unknown as http.ServerResponse,
			200,
			"text/javascript; charset=utf-8",
			path.join(os.tmpdir(), "another-missing.js"),
		);
		await waitForFinish(res);
		expect(res.destroyed).toBe(true);
		writeSpy.mockRestore();
	});

	it("streams an existing file to the response", async () => {
		const file = path.join(os.tmpdir(), `yolomatic-stream-test-${Date.now()}.js`);
		await writeFile(file, "export default 1;");
		const res = createMockResponse();
		sendStream(res as unknown as http.ServerResponse, 200, "text/javascript; charset=utf-8", file);
		await waitForFinish(res);
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
		expect(res.body).toBe("export default 1;");
		await rm(file, { force: true });
	});
});