import type { Octokit } from "@octokit/rest";
import type {
	AccessibleRepo,
	CollaboratorPermission,
	PendingInvitation,
	RepositoryInfo,
	RepoVisibility,
} from "../../../ports/github-service.js";

/**
 * Focused delegate for account, repository, invitation, collaborator, and
 * repository-history operations. Owns the `normalizeVisibility` fallback and
 * the method-specific null/empty fallbacks for these calls.
 */
export class AccountRepositoryDelegate {
	constructor(private readonly octokit: Octokit) {}

	async getAuthenticatedUser(): Promise<{ login: string } | null> {
		try {
			const { data } = await this.octokit.users.getAuthenticated();
			if (data.login) {
				return { login: data.login };
			}
			return null;
		} catch {
			return null;
		}
	}

	async listAccessibleRepositories(): Promise<AccessibleRepo[]> {
		try {
			const { data } = await this.octokit.repos.listForAuthenticatedUser({ per_page: 100, sort: "updated" });
			return data.map((repo) => ({
				owner: repo.owner?.login ?? "",
				repo: repo.name ?? "",
				fullName: repo.full_name ?? "",
				visibility: this.normalizeVisibility(repo.visibility, repo.private),
			}));
		} catch {
			return [];
		}
	}

	async getRepository(owner: string, repo: string): Promise<RepositoryInfo | null> {
		try {
			const { data } = await this.octokit.repos.get({ owner, repo });
			return {
				owner: data.owner?.login ?? owner,
				repo: data.name ?? repo,
				fullName: data.full_name ?? `${owner}/${repo}`,
				visibility: this.normalizeVisibility(data.visibility, data.private),
			};
		} catch {
			return null;
		}
	}

	async getCollaboratorPermissionLevel(
		owner: string,
		repo: string,
		username: string,
	): Promise<CollaboratorPermission | null> {
		try {
			const { data } = await this.octokit.repos.getCollaboratorPermissionLevel({ owner, repo, username });
			const permission = data?.permission;
			if (
				permission === "admin" ||
				permission === "maintain" ||
				permission === "write" ||
				permission === "triage" ||
				permission === "read"
			) {
				return permission;
			}
			return null;
		} catch {
			return null;
		}
	}

	async isCollaborator(owner: string, repo: string, username: string): Promise<boolean> {
		try {
			const response = await this.octokit.repos.checkCollaborator({ owner, repo, username });
			return response?.status === 204;
		} catch {
			return false;
		}
	}

	async initializeEmptyRepo(owner: string, repo: string, defaultBranch: string): Promise<void> {
		const { data } = await this.octokit.repos.get({ owner, repo });
		const branch = data.default_branch ?? defaultBranch;

		await this.octokit.repos.createOrUpdateFileContents({
			owner,
			repo,
			path: "README.md",
			message: "Initial commit",
			content: Buffer.from(`# ${repo}\n\nAuto-initialized by Yolomatic.\n`).toString("base64"),
			branch,
		});
	}

	async listRecentCommits(owner: string, repo: string, limit = 10): Promise<string[]> {
		try {
			const { data } = await this.octokit.repos.listCommits({ owner, repo, per_page: limit });
			return data.map((c) => `${c.sha.slice(0, 7)}: ${c.commit.message.split("\n")[0]}`);
		} catch {
			return [];
		}
	}

	async listPendingInvitations(): Promise<PendingInvitation[]> {
		try {
			const { data } = await this.octokit.repos.listInvitationsForAuthenticatedUser();
			return data.map((inv) => ({
				id: inv.id,
				repository: {
					full_name: inv.repository?.full_name ?? "",
					name: inv.repository?.name ?? "",
					owner: { login: inv.repository?.owner?.login ?? "" },
				},
				inviter: inv.inviter ? { login: inv.inviter.login } : null,
				permissions: inv.permissions ?? "read",
				created_at: inv.created_at,
				html_url: inv.html_url ?? "",
			}));
		} catch {
			return [];
		}
	}

	async acceptInvitation(invitationId: number): Promise<void> {
		await this.octokit.repos.acceptInvitationForAuthenticatedUser({ invitation_id: invitationId });
	}

	private normalizeVisibility(
		visibility: unknown,
		isPrivate: unknown,
	): RepoVisibility {
		const normalized = String(visibility ?? "").toLowerCase();
		if (normalized === "public" || normalized === "private" || normalized === "internal") {
			return normalized;
		}
		return isPrivate ? "private" : "public";
	}
}