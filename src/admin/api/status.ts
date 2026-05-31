import { apiGet } from "./client.js";
import type { StatusResponse } from "../app/types.js";

export function fetchStatus(): Promise<StatusResponse> {
	return apiGet<StatusResponse>("/api/status");
}
