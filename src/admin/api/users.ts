import { apiGet, apiPost, apiPatch, apiDelete } from "./client.js";

export interface User {
	id: string;
	fullName: string;
	username: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreateUserRequest {
	full_name: string;
	username: string;
	password: string;
}

export interface UpdateUserRequest {
	full_name: string;
}

export interface ResetPasswordRequest {
	password: string;
}

export function listUsers(): Promise<{ users: User[] }> {
	return apiGet<{ users: User[] }>("/api/users");
}

export function createUser(body: CreateUserRequest): Promise<User> {
	return apiPost<User>("/api/users", body);
}

export function updateUserFullName(id: string, body: UpdateUserRequest): Promise<User> {
	return apiPatch<User>(`/api/users/${encodeURIComponent(id)}`, body);
}

export function resetUserPassword(id: string, body: ResetPasswordRequest): Promise<User> {
	return apiPost<User>(`/api/users/${encodeURIComponent(id)}/password`, body);
}

export function deleteUser(id: string): Promise<{ deleted: boolean }> {
	return apiDelete<{ deleted: boolean }>(`/api/users/${encodeURIComponent(id)}`);
}