import React from "react";
import type { OpenIssue } from "../../api/issues.js";

export function IssueListPane({
	issues,
	selected,
	onSelect,
}: {
	issues: OpenIssue[];
	selected: OpenIssue | null;
	onSelect: (issue: OpenIssue) => void;
}): React.ReactElement {
	return (
		<div className="list-pane">
			<div className="list-header">
				<div className="list-col issue-number">#</div>
				<div className="list-col issue-title">Title</div>
				<div className="list-col issue-labels">Labels</div>
			</div>
			<div className="list-body">
				{issues.map((issue) => {
					const isSelected = selected?.number === issue.number;
					return (
						<div
							key={issue.number}
							className={`list-row${isSelected ? " selected" : ""}`}
							onClick={() => onSelect(issue)}
							tabIndex={0}
							role="button"
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onSelect(issue);
								}
							}}
						>
							<div className="list-col issue-number">#{issue.number}</div>
							<div className="list-col issue-title">{issue.title}</div>
							<div className="list-col issue-labels">
								{issue.labels.length > 0 ? (
									<span className="issue-label-summary">{issue.labels.slice(0, 3).join(", ")}</span>
								) : (
									<span className="issue-label-empty">—</span>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
