export interface ServerSkill {
	id: string;
	name: string;
	description: string;
	content: string;
	enabled: boolean;
	updatedAt: string;
	createdAt: string;
}

export interface RepoSkill {
	name: string;
	description: string;
	content: string;
	enabled: boolean;
	updatedAt: string;
	source: "server" | "repo" | "inherited";
}

export interface SkillFormData {
	name: string;
	description: string;
	content: string;
	enabled: boolean;
}

export interface ParsedSkillFile {
	name: string;
	description: string;
	content: string;
}
