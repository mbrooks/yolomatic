import { useEffect, useState } from "react";
import { fetchRepoContext, type RepoContext } from "../../api/issues.js";

export function useRepoContext(owner: string, repo: string): {
	repoContext: RepoContext | null;
	loadingContext: boolean;
	selectedTemplate: string | undefined;
	setSelectedTemplate: (template: string | undefined) => void;
	clearRepoContext: () => void;
} {
	const [repoContext, setRepoContext] = useState<RepoContext | null>(null);
	const [selectedTemplate, setSelectedTemplate] = useState<string | undefined>(undefined);
	const [loadingContext, setLoadingContext] = useState(false);

	useEffect(() => {
		if (!owner || !repo) {
			setRepoContext(null);
			return;
		}
		setLoadingContext(true);
		fetchRepoContext(owner, repo)
			.then((context) => {
				setRepoContext(context);
			})
			.catch(() => {
				setRepoContext(null);
			})
			.finally(() => {
				setLoadingContext(false);
			});
	}, [owner, repo]);

	return {
		repoContext,
		loadingContext,
		selectedTemplate,
		setSelectedTemplate,
		clearRepoContext: () => {
			setRepoContext(null);
			setSelectedTemplate(undefined);
		},
	};
}
