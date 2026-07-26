import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { sendHtml, sendText } from "./response-helpers.js";
import { DEFAULT_ADMIN_DEFAULT_PAGE, DEFAULT_ADMIN_PATH } from "../../config.js";

function contentTypeFor(path: string): string {
	const extension = extname(path);
	if (extension === ".css") return "text/css; charset=utf-8";
	if (extension === ".html") return "text/html; charset=utf-8";
	if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
	if (extension === ".json") return "application/json; charset=utf-8";
	if (extension === ".map") return "application/json; charset=utf-8";
	if (extension === ".svg") return "image/svg+xml";
	if (extension === ".png") return "image/png";
	if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
	if (extension === ".ico") return "image/x-icon";
	return "application/octet-stream";
}

function fallbackAdminHtml(): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>TARS Admin</title>
	</head>
	<body>
		<div id="root">TARS Admin assets have not been built.</div>
	</body>
</html>`;
}

/**
 * Inject runtime admin configuration into the served index.html so the SPA
 * can resolve the configured admin path prefix and default landing page
 * without rebuilding the bundle.
 */
export function injectAdminConfig(
	html: string,
	adminPath: string = DEFAULT_ADMIN_PATH,
	adminDefaultPage: string = DEFAULT_ADMIN_DEFAULT_PAGE,
): string {
	const script = `<script>window.__TARS_ADMIN_PATH__ = ${JSON.stringify(adminPath)}; window.__TARS_ADMIN_DEFAULT_PAGE__ = ${JSON.stringify(adminDefaultPage)};</script>`;
	if (html.includes("</head>")) {
		return html.replace("</head>", `${script}</head>`);
	}
	if (html.includes("<body>")) {
		return html.replace("<body>", `<body>${script}`);
	}
	return `${script}${html}`;
}

export async function adminHtml(
	adminAssetsDir: string,
	adminPath: string = DEFAULT_ADMIN_PATH,
	adminDefaultPage: string = DEFAULT_ADMIN_DEFAULT_PAGE,
): Promise<string> {
	try {
		const html = await readFile(join(adminAssetsDir, "index.html"), "utf8");
		return injectAdminConfig(html, adminPath, adminDefaultPage);
	} catch {
		return fallbackAdminHtml();
	}
}

export function sendStream(response: ServerResponse, statusCode: number, contentType: string, path: string): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", contentType);
	createReadStream(path)
		.on("error", (error) => {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] admin asset error: ${message}\n`);
			if (!response.headersSent) {
				sendText(response, 500, "Unable to read admin asset");
			} else {
				response.destroy();
			}
		})
		.pipe(response);
}

export async function serveAdminAsset(response: ServerResponse, adminAssetsDir: string, assetPath: string): Promise<void> {
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(assetPath);
	} catch {
		sendText(response, 400, "Invalid asset path");
		return;
	}
	const resolvedPath = resolve(adminAssetsDir, decodedPath);
	const relativePath = relative(adminAssetsDir, resolvedPath);
	if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith("/")) {
		sendText(response, 404, "Not found");
		return;
	}

	try {
		const assetStat = await stat(resolvedPath);
		if (!assetStat.isFile()) {
			sendText(response, 404, "Not found");
			return;
		}
	} catch {
		sendText(response, 404, "Not found");
		return;
	}

	sendStream(response, 200, contentTypeFor(resolvedPath), resolvedPath);
}
