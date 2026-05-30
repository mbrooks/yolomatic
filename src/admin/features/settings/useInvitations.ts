import { useCallback, useEffect, useState } from "react";
import { fetchPendingInvitations, acceptInvitation, type PendingInvitation } from "../../api/github.js";

export function useInvitations(): {
	invitations: PendingInvitation[];
	loading: boolean;
	accepting: number | null;
	reload: () => void;
	accept: (id: number) => Promise<void>;
} {
	const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
	const [loading, setLoading] = useState(true);
	const [accepting, setAccepting] = useState<number | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const data = await fetchPendingInvitations();
			setInvitations(data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Failed to load invitations: ${message}\n`);
		} finally {
			setLoading(false);
		}
	}, []);

	const accept = useCallback(async (id: number) => {
		setAccepting(id);
		try {
			await acceptInvitation(id);
			setInvitations((prev) => prev.filter((inv) => inv.id !== id));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Failed to accept invitation: ${message}\n`);
			throw error;
		} finally {
			setAccepting(null);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return {
		invitations,
		loading,
		accepting,
		reload: () => {
			void load();
		},
		accept,
	};
}
