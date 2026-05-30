import React from "react";
import { useInvitations } from "./useInvitations.js";

export function InvitationsSection(): React.ReactElement {
	const { invitations, loading, accepting, reload, accept } = useInvitations();

	return (
		<div className="dashboard-section">
			<div className="invitations-header">
				<h2>GitHub Invitations</h2>
				<button className="action-btn complete" onClick={reload} type="button">
					Refresh
				</button>
			</div>
			{loading ? (
				<div className="empty-state">
					<p>Loading invitations...</p>
				</div>
			) : invitations.length === 0 ? (
				<div className="empty-state">
					<p>No pending invitations.</p>
				</div>
			) : (
				<div className="invitation-list">
					{invitations.map((inv) => (
						<div key={inv.id} className="invitation-row">
							<div className="invitation-info">
								<div className="invitation-repo">
									<a
										href={inv.html_url}
										target="_blank"
										rel="noreferrer"
									>
										{inv.repository.full_name}
									</a>
								</div>
								<div className="invitation-meta">
									Invited by {inv.inviter?.login ?? "unknown"} • {inv.permissions}
								</div>
							</div>
							<button
								className="action-btn complete"
								disabled={accepting === inv.id}
								onClick={() => {
									void accept(inv.id);
								}}
								type="button"
							>
								{accepting === inv.id ? "Accepting..." : "Accept"}
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
