import React from "react";
import type { ServerSkill, RepoSkill } from "../../app/types.js";

interface SkillListPaneProps {
	skills: (ServerSkill | RepoSkill)[];
	selected: ServerSkill | RepoSkill | null;
	onSelect: (skill: ServerSkill | RepoSkill) => void;
	onCreate: () => void;
}

export function SkillListPane({ skills, selected, onSelect, onCreate }: SkillListPaneProps): React.ReactElement {
	return (
		<div className="list-pane">
			<div className="list-header">
				<span className="list-title">Skills ({skills.length})</span>
				<button className="action-btn small" onClick={onCreate} type="button">
					+ New
				</button>
			</div>
			<div className="list-body">
				{skills.length === 0 ? (
					<div className="list-empty">No skills.</div>
				) : (
					skills.map((skill) => (
						<button
							key={"id" in skill ? skill.id : skill.name}
							className={`list-item${selected && ("id" in selected && "id" in skill && selected.id === skill.id || "name" in selected && "name" in skill && selected.name === skill.name) ? " active" : ""}`}
							onClick={() => onSelect(skill)}
							type="button"
						>
							<span className="list-item-title">{skill.name}</span>
							{"source" in skill && skill.source === "inherited" && (
								<span className="skill-badge inherited">inherited</span>
							)}
							{"source" in skill && skill.source === "repo" && (
								<span className="skill-badge repo">repo</span>
							)}
							{!skill.enabled && <span className="skill-badge disabled">disabled</span>}
							<span className="list-item-subtitle">{skill.description || "No description"}</span>
						</button>
					))
				)}
			</div>
		</div>
	);
}
