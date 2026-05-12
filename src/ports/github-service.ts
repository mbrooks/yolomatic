export interface PullRequestInfo {
	head: { ref: string };
	state: string;
	merged: boolean;
}

export interface ReviewComment {
	id: number;
	body: string;
	user?: { login: string };
	path?: string;
	line?: number | null;
}

export interface CreatedPR {
	number: number;
	html_url: string;
}

export interface GitHubService {
	postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void>;
	postPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<void>;
	addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void>;
	removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void>;
	getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo | null>;
	createPullRequest(
		owner: string,
		repo: string,
		title: string,
		body: string,
		head: string,
		base: string,
	): Promise<CreatedPR | null>;
	listPullRequests(
		owner: string,
		repo: string,
		options: { head: string; base: string; state: string },
	): Promise<CreatedPR[]>;
	getIssue(owner: string, repo: string, issueNumber: number): Promise<{ state: string } | null>;
	fileSelfReport(title: string, body: string, labels: string[]): Promise<string>;
	listReviewComments(owner: string, repo: string, prNumber: number, reviewId: number): Promise<ReviewComment[]>;
}
