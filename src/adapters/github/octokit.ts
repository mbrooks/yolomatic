import { Octokit } from "@octokit/rest";

export const GITHUB_API_VERSION = "2022-11-28";

export function createOctokit(auth: string): Octokit {
	return new Octokit({
		auth,
		headers: {
			"X-GitHub-Api-Version": GITHUB_API_VERSION,
		},
	});
}
