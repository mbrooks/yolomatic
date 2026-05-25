import { useCallback, useEffect, useState } from "react";
import { fetchCrons } from "../../api/crons.js";
import type { CronJob } from "../../app/types.js";

export function useRepoCrons(owner: string, repo: string): {
	crons: CronJob[];
	loading: boolean;
	reload: () => void;
} {
	const [crons, setCrons] = useState<CronJob[]>([]);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const data = await fetchCrons(owner, repo);
			setCrons(data.crons);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Failed to load crons: ${message}\n`);
		} finally {
			setLoading(false);
		}
	}, [owner, repo]);

	useEffect(() => {
		void load();
	}, [load]);

	return {
		crons,
		loading,
		reload: () => {
			void load();
		},
	};
}
