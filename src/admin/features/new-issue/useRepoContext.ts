import { useEffect, useState } from "react";
import { fetchRepoContext, type RepoContext } from "../../api/issues.js";
import { fetchRepoSkills } from "../../api/skills.js";
import type { RepoSkill } from "../../app/types.js";

export function useRepoContext(owner: string, repo: string): {
	repoContext: RepoContext | null;
	loadingContext: boolean;
	selectedTemplate: string | undefined;
	setSelectedTemplate: (template: string | undefined) => void;
	clearRepoContext: () => void;
	skills: RepoSkill[];
	loadingSkills: boolean;
} {
	const [repoContext, setRepoContext] = useState<RepoContext | null>(null);
	const [selectedTemplate, setSelectedTemplate] = useState<string | undefined>(undefined);
	const [loadingContext, setLoadingContext] = useState(false);
	const [skills, setSkills] = useState<RepoSkill[]>([]);
	const [loadingSkills, setLoadingSkills] = useState(false);

	useEffect(() => {
		if (!owner || !repo) {
			setRepoContext(null);
			setSkills([]);
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

		setLoadingSkills(true);
		fetchRepoSkills(owner, repo)
			.then((data) => setSkills(data.skills ?? []))
			.catch(() => setSkills([]))
			.finally(() => setLoadingSkills(false));
	}, [owner, repo]);

	return {
		repoContext,
		loadingContext,
		selectedTemplate,
		setSelectedTemplate,
		clearRepoContext: () => {
			setRepoContext(null);
			setSelectedTemplate(undefined);
			setSkills([]);
		},
		skills,
		loadingSkills,
	};
}
