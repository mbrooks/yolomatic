export interface ServerSkill {
	id: string;
	name: string;
	description: string;
	content: string;
	updatedAt: string;
	createdAt: string;
}

export interface RepoSkill {
	name: string;
	description: string;
	content: string;
	updatedAt: string;
	source: "server" | "repo" | "inherited";
}

export interface SkillFormData {
	name: string;
	description: string;
	content: string;
}

export interface ParsedSkillFile {
	name: string;
	description: string;
	content: string;
}
