import type { RepoSkill, ServerSkill } from "./model.js";

/**
 * Merge repo-local skills with server-wide skills.
 *
 * Repo skills override server skills of the same name (the repo entry wins,
 * tagged with `source: "repo"`). Server skills with no repo counterpart are
 * inherited and tagged with `source: "inherited"`. Repo-only skills are
 * included as-is. The result is ordered by skill name.
 */
export function mergeRepoAndServerSkills(
	repoSkills: RepoSkill[],
	serverSkills: ServerSkill[],
): RepoSkill[] {
	const repoMap = new Map(repoSkills.map((skill) => [skill.name, skill]));
	const merged: RepoSkill[] = [];

	for (const serverSkill of serverSkills) {
		if (repoMap.has(serverSkill.name)) {
			const repoSkill = repoMap.get(serverSkill.name)!;
			merged.push({ ...repoSkill, source: "repo" });
			continue;
		}
		merged.push({
			name: serverSkill.name,
			description: serverSkill.description,
			content: serverSkill.content,
			updatedAt: serverSkill.updatedAt,
			source: "inherited",
		});
	}

	for (const repoSkill of repoSkills) {
		if (!serverSkills.some((skill) => skill.name === repoSkill.name)) {
			merged.push({ ...repoSkill, source: "repo" });
		}
	}

	return merged.sort((a, b) => a.name.localeCompare(b.name));
}