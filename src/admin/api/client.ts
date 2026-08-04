export async function apiGet<T>(path: string): Promise<T> {
	const response = await fetch(path);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
	const options: RequestInit = { method: "POST" };
	if (body !== undefined) {
		options.headers = { "Content-Type": "application/json" };
		options.body = JSON.stringify(body);
	}
	const response = await fetch(path, options);
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? response.statusText);
	}
	return (await response.json()) as T;
}

export async function apiDelete<T>(path: string): Promise<T> {
	const response = await fetch(path, { method: "DELETE" });
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? response.statusText);
	}
	return (await response.json()) as T;
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
	const options: RequestInit = { method: "PATCH" };
	if (body !== undefined) {
		options.headers = { "Content-Type": "application/json" };
		options.body = JSON.stringify(body);
	}
	const response = await fetch(path, options);
	if (!response.ok) {
		const data = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? response.statusText);
	}
	return (await response.json()) as T;
}
