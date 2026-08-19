/**
 * Shared update-payload builders for GitHub issue/PR update operations.
 *
 * `updateIssue` and `updatePullRequest` both build an Octokit update payload
 * from the same optional title/body/state fields. That mapping is extracted
 * here so the two delegates stay behavior-identical for those fields.
 */
export interface StatefulUpdateFields {
	title?: string;
	body?: string;
	state?: "open" | "closed";
}

/**
 * Build an Octokit update payload containing only the title/body/state fields
 * that are present on `fields`. Undefined fields are omitted; empty-string
 * values are preserved.
 */
export function buildStatefulUpdateFields(fields: StatefulUpdateFields): Record<string, unknown> {
	const update: Record<string, unknown> = {};
	if (fields.title !== undefined) update.title = fields.title;
	if (fields.body !== undefined) update.body = fields.body;
	if (fields.state !== undefined) update.state = fields.state;
	return update;
}