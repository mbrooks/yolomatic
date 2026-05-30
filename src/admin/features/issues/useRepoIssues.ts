import { useCallback, useEffect, useState } from "react";
import { fetchOpenIssues } from "../../api/issues.js";
import type { OpenIssue } from "../../api/issues.js";

export function useRepoIssues(owner: string, repo: string): {
	issues: OpenIssue[];
	loading: boolean;
	reload: () => void;
} {
	const [issues, setIssues] = useState<OpenIssue[]>([]);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const data = await fetchOpenIssues(owner, repo);
			setIssues(data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Failed to load issues: ${message}\n`);
		} finally {
			setLoading(false);
		}
	}, [owner, repo]);

	useEffect(() => {
		void load();
	}, [load]);

	return {
		issues,
		loading,
		reload: () => {
			void load();
		},
	};
}
