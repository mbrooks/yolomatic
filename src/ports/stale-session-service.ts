import type { StaleSessionInfo } from "../session/stale-detector.js";

export interface StaleSessionService {
	detectStaleSessions(): Promise<StaleSessionInfo[]>;
}
