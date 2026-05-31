import React, { useCallback, useState } from "react";
import { EmptyState } from "../../components/EmptyState.js";
import type { ServerSkill } from "../../app/types.js";
import { useServerSkills } from "./useSkills.js";
import { SkillListPane } from "./SkillListPane.js";
import { SkillForm } from "./SkillForm.js";
import { createServerSkill, updateServerSkill, deleteServerSkill } from "../../api/skills.js";

export function ServerSkillsScreen({
	showBreadcrumb = true,
	onBack,
}: {
	showBreadcrumb?: boolean;
	onBack?: () => void;
}): React.ReactElement {
	const { skills, loading, reload } = useServerSkills();
	const [selectedSkill, setSelectedSkill] = useState<ServerSkill | null>(null);
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
		if (!window.confirm(`Delete server skill "${selectedSkill.name}"?`)) return;
		try {
			await deleteServerSkill(selectedSkill.id);
			handleMutate();
		} catch (err) {
			setDetailError(err instanceof Error ? err.message : String(err));
		}
	}, [selectedSkill, handleMutate]);

	if (loading) {
		return (
			<div className="skills-screen">
				{showBreadcrumb && onBack ? (
					<header className="breadcrumb">
						<button onClick={onBack} type="button">← Back</button>
						<h2>Server Skills</h2>
					</header>
				) : null}
				<div className="empty">Loading skills...</div>
			</div>
		);
	}

	return (
		<div className="skills-screen">
			{showBreadcrumb && onBack ? (
				<header className="breadcrumb">
					<button onClick={onBack} type="button">← Back</button>
					<h2>Server Skills</h2>
				</header>
			) : null}
			{skills.length === 0 && !showForm ? (
				<EmptyState message="No server-level skills defined.">
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
							setSelectedSkill(skill as ServerSkill);
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
									await updateServerSkill(selectedSkill.id, data);
								} else {
									await createServerSkill(data);
								}
								handleMutate();
							}}
							onCancel={() => {
								setShowForm(false);
								setSelectedSkill(null);
							}}
						/>
					) : selectedSkill ? (
						<div className="detail-pane">
							<div className="detail-title">{selectedSkill.name}</div>
							<div className="detail-section">
								<span className={`skill-status ${selectedSkill.enabled ? "enabled" : "disabled"}`}>
									{selectedSkill.enabled ? "Enabled" : "Disabled"}
								</span>
								<p className="skill-description">{selectedSkill.description || "No description"}</p>
							</div>
							<div className="detail-section">
								<h3>Content</h3>
								<pre className="skill-content">{selectedSkill.content}</pre>
							</div>
							{detailError && <div className="form-error">{detailError}</div>}
							<div className="detail-actions">
								<button className="action-btn" type="button" onClick={() => setShowForm(true)}>
									Edit
								</button>
								<button className="action-btn delete" type="button" onClick={handleDelete}>
									Delete
								</button>
							</div>
						</div>
					) : (
						<div className="detail-pane empty">
							Select a skill from the list to view or edit.
						</div>
					)}
				</div>
			)}
		</div>
	);
}
