export interface WorkerTemplate {
	id: string;
	label: string;
	image: string;
	dockerfile: string;
}

export const DEFAULT_WORKER_TEMPLATE = "node";
export const BASE_WORKER_IMAGE = "yolomatic-worker-base:latest";
export const BASE_WORKER_DOCKERFILE = "workers/base-runtime.Dockerfile";

const WORKER_TEMPLATES: readonly WorkerTemplate[] = [
	{ id: "node", label: "Node.js", image: "yolomatic-worker-node:latest", dockerfile: "workers/node.Dockerfile" },
	{ id: "php", label: "PHP", image: "yolomatic-worker-php:latest", dockerfile: "workers/php.Dockerfile" },
	{ id: "python", label: "Python", image: "yolomatic-worker-python:latest", dockerfile: "workers/python.Dockerfile" },
	{ id: "rust", label: "Rust", image: "yolomatic-worker-rust:latest", dockerfile: "workers/rust.Dockerfile" },
];

export function listWorkerTemplates(): WorkerTemplate[] {
	return [...WORKER_TEMPLATES];
}

export function getWorkerTemplate(id: string): WorkerTemplate | undefined {
	return WORKER_TEMPLATES.find((template) => template.id === id);
}

export function resolveWorkerTemplate(repoOverride: string | null | undefined, defaultTemplate: string): WorkerTemplate {
	const id = repoOverride ?? defaultTemplate;
	const template = getWorkerTemplate(id);
	if (!template) {
		throw new Error(`Unknown worker template: ${id}`);
	}
	return template;
}
