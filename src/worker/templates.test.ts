import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
	BASE_WORKER_DOCKERFILE,
	BASE_WORKER_IMAGE,
	DEFAULT_WORKER_TEMPLATE,
	getWorkerTemplate,
	listWorkerTemplates,
	resolveWorkerTemplate,
} from "./templates.js";

describe("worker templates", () => {
	it("keeps a worker-only base runtime out of the selectable language templates", () => {
		expect(BASE_WORKER_IMAGE).toBe("yolomatic-worker-base:latest");
		expect(BASE_WORKER_DOCKERFILE).toBe("workers/base-runtime.Dockerfile");
		expect(listWorkerTemplates().map((template) => template.id)).not.toContain("base-runtime");
	});

	it("uses the worker-only base rather than the controller runtime", () => {
		const base = readFileSync(path.resolve("workers/base-runtime.Dockerfile"), "utf8");
		expect(base).toContain("FROM node:26-bookworm-slim");
		expect(base).not.toContain("node:24-bookworm-slim");
		expect(base).not.toContain("FROM base-runtime");

		for (const template of listWorkerTemplates()) {
			const dockerfile = readFileSync(path.resolve(template.dockerfile), "utf8");
			expect(dockerfile).toContain("FROM yolomatic-worker-base:latest");
		}
	});

	it("installs NVM and selects Node 26 in the Node worker", () => {
		const nodeDockerfile = readFileSync(path.resolve("workers/node.Dockerfile"), "utf8");
		expect(nodeDockerfile).toContain("nvm install 26");
		expect(nodeDockerfile).toContain("nvm alias default 26");
	});

	it("lists the standalone Node, Python, Rust, and PHP worker Dockerfiles", () => {
		expect(listWorkerTemplates()).toEqual([
			{ id: "node", label: "Node.js", image: "yolomatic-worker-node:latest", dockerfile: "workers/node.Dockerfile" },
			{ id: "php", label: "PHP", image: "yolomatic-worker-php:latest", dockerfile: "workers/php.Dockerfile" },
			{ id: "python", label: "Python", image: "yolomatic-worker-python:latest", dockerfile: "workers/python.Dockerfile" },
			{ id: "rust", label: "Rust", image: "yolomatic-worker-rust:latest", dockerfile: "workers/rust.Dockerfile" },
		]);
	});

	it("resolves a repository override and falls back to the global default", () => {
		expect(DEFAULT_WORKER_TEMPLATE).toBe("node");
		expect(resolveWorkerTemplate("python", "node").id).toBe("python");
		expect(resolveWorkerTemplate(null, "rust").id).toBe("rust");
	});

	it("rejects unknown template IDs instead of launching an arbitrary image", () => {
		expect(getWorkerTemplate("unknown")).toBeUndefined();
		expect(() => resolveWorkerTemplate("unknown", "node")).toThrow("Unknown worker template: unknown");
	});
});
