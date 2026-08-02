import { apiGet } from "./client.js";

/** Structured Ollama sign-in status returned by `GET /api/ollama/signin`. */
export interface OllamaSignInStatus {
	signedIn: boolean;
	user?: string;
	signInUrl?: string;
	message: string;
	error?: string;
}

export function fetchOllamaSignInStatus(): Promise<OllamaSignInStatus> {
	return apiGet<OllamaSignInStatus>("/api/ollama/signin");
}