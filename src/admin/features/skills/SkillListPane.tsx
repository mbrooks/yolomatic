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
					skills.map((skill) => {
						const isSelected =
							selected &&
							(("id" in selected && "id" in skill && selected.id === skill.id) ||
								("name" in selected && "name" in skill && selected.name === skill.name));
						return (
							<div
								key={"id" in skill ? skill.id : skill.name}
								className={`list-row${isSelected ? " selected" : ""}`}
								onClick={() => onSelect(skill)}
								tabIndex={0}
								role="button"
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										onSelect(skill);
									}
								}}
							>
								<div className="list-col skill-name">
									<div className="skill-name-row">
										<span>{skill.name}</span>
										{"source" in skill && skill.source === "inherited" && (
											<span className="skill-badge inherited">inherited</span>
										)}
										{"source" in skill && skill.source === "repo" && (
											<span className="skill-badge repo">repo</span>
										)}
										{!skill.enabled && <span className="skill-badge disabled">disabled</span>}
									</div>
									<div className="skill-subtitle">{skill.description || "No description"}</div>
								</div>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
