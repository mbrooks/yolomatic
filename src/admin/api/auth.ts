import { apiGet, apiPost } from "./client.js";

export interface AuthUser {
	id: string;
	fullName: string;
	username: string;
	createdAt: string;
	updatedAt: string;
}

export interface LoginRequest {
	username: string;
	password: string;
}

export function login(body: LoginRequest): Promise<{ user: AuthUser }> {
	return apiPost<{ user: AuthUser }>("/api/login", body);
}

export function logout(): Promise<{ ok: boolean }> {
	return apiPost<{ ok: boolean }>("/api/logout");
}

export function fetchMe(): Promise<{ user: AuthUser }> {
	return apiGet<{ user: AuthUser }>("/api/me");
}