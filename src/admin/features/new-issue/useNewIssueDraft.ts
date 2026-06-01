import { useCallback, useState } from "react";
import { createIssue, type IssueDraft } from "../../api/issues.js";

const EMPTY_DRAFT: IssueDraft = {
	title: "",
	body: "",
	labels: [],
	assignees: [],
};

export function hasDraftContent(draft: IssueDraft): boolean {
	return Boolean(
		draft.title.trim() ||
		draft.body.trim() ||
		draft.labels.length > 0 ||
		draft.assignees.length > 0,
	);
}

export function useNewIssueDraft({
	initialOwner,
	initialRepo,
	onAssistantMessage,
}: {
	initialOwner: string;
	initialRepo: string;
	onAssistantMessage: (message: string) => void;
}): {
	owner: string;
	setOwner: (owner: string) => void;
	repo: string;
	setRepo: (repo: string) => void;
	draft: IssueDraft;
	setDraft: (draft: IssueDraft) => void;
	creatingIssue: boolean;
	createdIssue: { number: number; html_url: string } | null;
	setCreatedIssue: (issue: { number: number; html_url: string } | null) => void;
	resetDraft: () => void;
	createCurrentIssue: () => Promise<string | null>;
} {
	const [owner, setOwner] = useState(initialOwner);
	const [repo, setRepo] = useState(initialRepo);
	const [draft, setDraft] = useState<IssueDraft>(EMPTY_DRAFT);
	const [creatingIssue, setCreatingIssue] = useState(false);
	const [createdIssue, setCreatedIssue] = useState<{ number: number; html_url: string } | null>(null);

	const resetDraft = useCallback(() => {
		setDraft(EMPTY_DRAFT);
		setCreatingIssue(false);
		setCreatedIssue(null);
	}, []);

	const createCurrentIssue = useCallback(async (): Promise<string | null> => {
		if (!owner.trim() || !repo.trim() || !draft.title.trim() || creatingIssue) {
			return null;
		}
		setCreatingIssue(true);
		try {
			const result = await createIssue({
				owner: owner.trim(),
				repo: repo.trim(),
				title: draft.title,
				body: draft.body || undefined,
				labels: draft.labels.length > 0 ? draft.labels : undefined,
				assignees: draft.assignees.length > 0 ? draft.assignees : undefined,
			});
			setCreatedIssue(result);
			onAssistantMessage(`Issue created: [#${result.number}](${result.html_url})`);
			return null;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			onAssistantMessage(`I couldn't create the issue: ${message}`);
			return message;
		} finally {
			setCreatingIssue(false);
		}
	}, [creatingIssue, draft, onAssistantMessage, owner, repo]);

	return {
		owner,
		setOwner,
		repo,
		setRepo,
		draft,
		setDraft,
		creatingIssue,
		createdIssue,
		setCreatedIssue,
		resetDraft,
		createCurrentIssue,
	};
}
