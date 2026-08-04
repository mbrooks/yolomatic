import React, { useCallback, useEffect, useState } from "react";
import {
	createUser,
	deleteUser,
	listUsers,
	resetUserPassword,
	updateUserFullName,
	type User,
} from "../../api/users.js";

interface NewUserDraft {
	fullName: string;
	username: string;
	password: string;
}

const EMPTY_DRAFT: NewUserDraft = { fullName: "", username: "", password: "" };

export function UsersScreen(): React.ReactElement {
	const [users, setUsers] = useState<User[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [draft, setDraft] = useState<NewUserDraft>(EMPTY_DRAFT);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await listUsers();
			setUsers(result.users);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const handleCreate = useCallback(async () => {
		if (!draft.fullName.trim() || !draft.username.trim() || !draft.password) {
			setError("Full name, username, and password are required");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await createUser({
				full_name: draft.fullName.trim(),
				username: draft.username.trim(),
				password: draft.password,
			});
			setDraft(EMPTY_DRAFT);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [draft, refresh]);

	const handleRename = useCallback(
		async (user: User) => {
			const next = window.prompt("Full name", user.fullName);
			if (next === null || next.trim() === user.fullName) return;
			setBusy(true);
			setError(null);
			try {
				await updateUserFullName(user.id, { full_name: next.trim() });
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[refresh],
	);

	const handleResetPassword = useCallback(
		async (user: User) => {
			const next = window.prompt(`New password for ${user.username}`, "");
			if (next === null || next === "") return;
			setBusy(true);
			setError(null);
			try {
				await resetUserPassword(user.id, { password: next });
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[refresh],
	);

	const handleDelete = useCallback(
		async (user: User) => {
			if (!window.confirm(`Delete user ${user.username}? This cannot be undone.`)) return;
			setBusy(true);
			setError(null);
			try {
				await deleteUser(user.id);
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[refresh],
	);

	return (
		<div className="settings-section">
			<h3 className="settings-section-title">Admin Users</h3>
			<p className="setting-description">
				Admin users can sign in to this dashboard. You cannot delete the last admin user.
			</p>
			{error && <div className="error-banner">{error}</div>}

			<section className="settings-section">
				<h4 className="settings-section-title">Add user</h4>
				<div className="onboarding-form">
					<div className="form-group">
						<label htmlFor="new-user-full-name">Full name</label>
						<input
							id="new-user-full-name"
							type="text"
							value={draft.fullName}
							onChange={(e) => setDraft((d) => ({ ...d, fullName: e.target.value }))}
							placeholder="Ada Lovelace"
						/>
					</div>
					<div className="form-group">
						<label htmlFor="new-user-username">Username</label>
						<input
							id="new-user-username"
							type="text"
							value={draft.username}
							onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
							placeholder="ada"
						/>
					</div>
					<div className="form-group">
						<label htmlFor="new-user-password">Password</label>
						<input
							id="new-user-password"
							type="password"
							value={draft.password}
							onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
							placeholder="password"
						/>
					</div>
					<div className="settings-actions">
						<button
							className="action-btn restart"
							type="button"
							onClick={() => void handleCreate()}
							disabled={busy}
						>
							{busy ? "Adding..." : "Add user"}
						</button>
					</div>
				</div>
			</section>

			{loading ? (
				<div className="empty">Loading users...</div>
			) : (
				<table className="settings-list" style={{ width: "100%", borderCollapse: "collapse" }}>
					<thead>
						<tr>
							<th style={{ textAlign: "left" }}>Full name</th>
							<th style={{ textAlign: "left" }}>Username</th>
							<th style={{ textAlign: "left" }}>Created</th>
							<th style={{ textAlign: "right" }}>Actions</th>
						</tr>
					</thead>
					<tbody>
						{users.map((user) => (
							<tr key={user.id}>
								<td>{user.fullName}</td>
								<td>{user.username}</td>
								<td>{user.createdAt}</td>
								<td style={{ textAlign: "right" }}>
									<button
										className="action-btn"
										type="button"
										onClick={() => void handleRename(user)}
										disabled={busy}
									>
										Rename
									</button>{" "}
									<button
										className="action-btn"
										type="button"
										onClick={() => void handleResetPassword(user)}
										disabled={busy}
									>
										Reset password
									</button>{" "}
									<button
										className="action-btn"
										type="button"
										onClick={() => void handleDelete(user)}
										disabled={busy || users.length <= 1}
									>
										Delete
									</button>
								</td>
							</tr>
						))}
						{users.length === 0 && (
							<tr>
								<td colSpan={4} className="empty">No admin users.</td>
							</tr>
						)}
					</tbody>
				</table>
			)}
		</div>
	);
}