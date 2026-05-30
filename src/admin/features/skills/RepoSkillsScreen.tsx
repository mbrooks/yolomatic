import React, { useCallback, useState } from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { EmptyState } from "../../components/EmptyState.js";
import { RepoTabs } from "../../components/RepoTabs.js";
import type { RepoSkill } from "../../app/types.js";
import { useRepoSkills } from "./useSkills.js";
import { SkillListPane } from "./SkillListPane.js";
import { SkillForm } from "./SkillForm.js";
import { createRepoSkill, updateRepoSkill, deleteRepoSkill } from "../../api/skills.js";

export function RepoSkillsScreen({
	owner,
	repo,
	activeTab,
	onSelectTab,
	onBack,
	onNewIssue,
}: {
	owner: string;
	repo: string;
	activeTab: "sessions" | "crons" | "skills";
	onSelectTab: (tab: "sessions" | "crons" | "skills" | "issues") => void;
	onBack: () => void;
	onNewIssue?: () => void;
}): React.ReactElement {
	const { skills, loading, reload } = useRepoSkills(owner, repo);
	const [selectedSkill, setSelectedSkill] = useState<RepoSkill | null>(null);
	const [showForm, setShowForm] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);

	const handleMutate = useCallback(() => {
		reload();
		setSelectedSkill(null);
		setShowForm(false);
		setDetailError(null);
	}, [reload]);

	const handleDelete = useCallback(async () => {
		if (!selectedSkill) return;
		if (!window.confirm(`Delete repo skill "${selectedSkill.name}"?`)) return;
		try {
			await deleteRepoSkill(owner, repo, selectedSkill.name);
			handleMutate();
		} catch (err) {
			setDetailError(err instanceof Error ? err.message : String(err));
		}
	}, [selectedSkill, owner, repo, handleMutate]);

	return (
		<>
			<RepoTabs activeTab={activeTab} onSelectTab={onSelectTab} onNewIssue={onNewIssue} />
			<Breadcrumb label={`${owner}/${repo}`} onBack={onBack} />
			{loading ? (
				<div className="empty">Loading skills...</div>
			) : skills.length === 0 && !showForm ? (
				<EmptyState message="No skills for this repository.">
					<button className="action-btn restart" onClick={() => setShowForm(true)} type="button">
						+ New Skill
					</button>
				</EmptyState>
			) : (
				<div className="workspace">
					<SkillListPane
						skills={skills}
						selected={selectedSkill}
						onSelect={(skill) => {
							setSelectedSkill(skill as RepoSkill);
							setShowForm(false);
						}}
						onCreate={() => {
							setShowForm(true);
							setSelectedSkill(null);
						}}
					/>
					{showForm ? (
						<SkillForm
							existing={selectedSkill}
							onSubmit={async (data) => {
								if (selectedSkill) {
									await updateRepoSkill(owner, repo, selectedSkill.name, data);
								} else {
									await createRepoSkill(owner, repo, data);
								}
								handleMutate();
							}}
							onCancel={() => {
								setShowForm(false);
								setSelectedSkill(null);
							}}
							submitLabel={selectedSkill ? "Save" : "Create & Push"}
						/>
					) : selectedSkill ? (
						<div className="detail-pane">
							<div className="detail-title">{selectedSkill.name}</div>
							<div className="detail-section">
								<span className={`skill-status ${selectedSkill.enabled ? "enabled" : "disabled"}`}>
									{selectedSkill.enabled ? "Enabled" : "Disabled"}
								</span>
								{selectedSkill.source === "inherited" && (
									<span className="skill-badge inherited">Inherited from server</span>
								)}
								<p className="skill-description">{selectedSkill.description || "No description"}</p>
							</div>
							<div className="detail-section">
								<h3>Content</h3>
								<pre className="skill-content">{selectedSkill.content}</pre>
							</div>
							{detailError && <div className="form-error">{detailError}</div>}
							<div className="detail-actions">
								{selectedSkill.source !== "inherited" && (
									<>
										<button className="action-btn" type="button" onClick={() => setShowForm(true)}>
											Edit
										</button>
										<button className="action-btn delete" type="button" onClick={handleDelete}>
											Delete
										</button>
									</>
								)}
							</div>
						</div>
					) : (
						<div className="detail-pane empty">
							Select a skill from the list to view or edit.
						</div>
					)}
				</div>
			)}
		</>
	);
}
