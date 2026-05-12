import type { StaleSessionService } from "../../ports/stale-session-service.js";
import type { StaleSessionDetector, StaleSessionInfo } from "../../session/stale-detector.js";

export class StaleSessionServiceAdapter implements StaleSessionService {
	constructor(private readonly detector: StaleSessionDetector) {}

	detectStaleSessions(): Promise<StaleSessionInfo[]> {
		return this.detector.detectStaleSessions();
	}
}
