import React, { useCallback, useState } from "react";
import type { ServerSkill, RepoSkill } from "../../app/types.js";
import type { SkillFormData } from "../../../skills/model.js";

interface SkillFormProps {
	existing: ServerSkill | RepoSkill | null;
	onSubmit: (data: SkillFormData) => void | Promise<void>;
	onCancel: () => void;
	submitLabel?: string;
}

export function SkillForm({ existing, onSubmit, onCancel, submitLabel = "Save" }: SkillFormProps): React.ReactElement {
	const [name, setName] = useState(existing?.name ?? "");
	const [description, setDescription] = useState(existing?.description ?? "");
	const [content, setContent] = useState(existing?.content ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			setSaving(true);
			setError(null);
			try {
				await onSubmit({ name, description, content });
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setSaving(false);
			}
		},
		[name, description, content, onSubmit],
	);

	return (
		<div className="detail-pane">
			<div className="detail-title">{existing ? "Edit Skill" : "New Skill"}</div>
			<form onSubmit={handleSubmit} className="skill-form">
				<div className="form-group">
					<label>Name</label>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
						maxLength={120}
						disabled={!!existing}
					/>
				</div>
				<div className="form-group">
					<label>Description</label>
					<textarea
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						maxLength={255}
						rows={3}
					/>
				</div>
				<div className="form-group">
					<label>Content (Markdown)</label>
					<textarea
						value={content}
						onChange={(e) => setContent(e.target.value)}
						required
						rows={10}
					/>
				</div>
				{error ? <div className="form-error">{error}</div> : null}
				<div className="detail-actions">
					<button className="action-btn complete" type="submit" disabled={saving}>
						{saving ? "Saving..." : submitLabel}
					</button>
					<button className="action-btn" type="button" onClick={onCancel} disabled={saving}>
						Cancel
					</button>
				</div>
			</form>
		</div>
	);
}
