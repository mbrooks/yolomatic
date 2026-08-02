import React from "react";
import { formatRelative } from "../../lib/format.js";
import type { Session } from "../../app/types.js";

export function SessionListPane({
	sessions,
	selected,
	onSelect,
}: {
	sessions: Session[];
	selected: Session | null;
	onSelect: (session: Session) => void;
}): React.ReactElement {
	return (
		<div className="list-pane">
			<div className="list-header">
				<div className="list-col issue">Issue</div>
				<div className="list-col type">Type</div>
				<div className="list-col status">Status</div>
				<div className="list-col activity">Activity</div>
			</div>
			<div className="list-body">
				{sessions.map((session) => {
					const isRefinement = session.kind === "refinement";
					const isSelected =
						selected?.owner === session.owner &&
						selected?.repo === session.repo &&
						selected?.issueNumber === session.issueNumber;
					return (
						<div
							key={`${session.owner}/${session.repo}#${session.issueNumber}`}
							className={`list-row${isSelected ? " selected" : ""}`}
							onClick={() => onSelect(session)}
							tabIndex={0}
							role="button"
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onSelect(session);
								}
							}}
						>
							<div className="list-col issue">#{session.issueNumber}</div>
							<div className="list-col type">
								<span className={`type-badge ${isRefinement ? "refinement" : "implementation"}`}>
									{isRefinement ? "Refinement" : "Issue"}
								</span>
							</div>
							<div className="list-col status">
								<span className={`status-badge ${session.status}`}>{session.status}</span>
							</div>
							<div className="list-col activity">{formatRelative(session.lastActivity)}</div>
							{session.stale?.isStale ? <span className="stale-dot" aria-label="Stale session" /> : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}
