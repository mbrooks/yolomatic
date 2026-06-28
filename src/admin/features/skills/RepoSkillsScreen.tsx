import React, { useCallback, useState } from "react";
import { RepoScopedScreenShell } from "../../components/RepoScopedScreenShell.js";
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
}: {
	owner: string;
	repo: string;
	activeTab: "sessions" | "skills" | "issues" | "settings";
	onSelectTab: (tab: "sessions" | "skills" | "issues" | "settings") => void;
	onBack: () => void;
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
		<RepoScopedScreenShell
			owner={owner}
			repo={repo}
			activeTab={activeTab}
			onSelectTab={onSelectTab}
			onBack={onBack}
			loading={loading}
			loadingMessage="Loading skills..."
			empty={skills.length === 0 && !showForm}
			emptyMessage="No skills for this repository."
			emptyAction={
					<button className="action-btn restart" onClick={() => setShowForm(true)} type="button">
						+ New Skill
					</button>
			}
		>
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
		</RepoScopedScreenShell>
	);
}
