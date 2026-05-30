import { useCallback, useEffect, useState } from "react";
import type { ServerSkill, RepoSkill } from "../../app/types.js";
import { fetchServerSkills, fetchRepoSkills } from "../../api/skills.js";

export function useServerSkills() {
	const [skills, setSkills] = useState<ServerSkill[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(() => {
		setLoading(true);
		setError(null);
		fetchServerSkills()
			.then((data) => setSkills(data.skills))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		reload();
	}, [reload]);

	return { skills, loading, error, reload };
}

export function useRepoSkills(owner: string, repo: string) {
	const [skills, setSkills] = useState<RepoSkill[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(() => {
		setLoading(true);
		setError(null);
		fetchRepoSkills(owner, repo)
			.then((data) => setSkills(data.skills))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	}, [owner, repo]);

	useEffect(() => {
		reload();
	}, [reload]);

	return { skills, loading, error, reload };
}
