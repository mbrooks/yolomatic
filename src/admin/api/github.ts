import { apiGet, apiPost } from "./client.js";

export interface PendingInvitation {
	id: number;
	repository: {
		full_name: string;
		name: string;
		owner: { login: string };
	};
	inviter: { login: string } | null;
	permissions: string;
	created_at: string;
	html_url: string;
}

export async function fetchPendingInvitations(): Promise<PendingInvitation[]> {
	return apiGet<{ invitations: PendingInvitation[] }>("/api/github/invitations").then((r) => r.invitations ?? []);
}

export async function acceptInvitation(id: number): Promise<{ accepted: boolean }> {
	return apiPost<{ accepted: boolean }>(`/api/github/invitations/${encodeURIComponent(String(id))}/accept`);
}
