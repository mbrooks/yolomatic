import { describe, expect, it } from "vitest";

import type { TaskControlService, TaskRegistration } from "./task-control-service.js";

describe("TaskControlService", () => {
	it("supports ownership-aware task registration", () => {
		const registration: TaskRegistration = Symbol("task");
		const service: TaskControlService = {
			cancel: () => false,
			isActive: () => true,
			steer: async () => true,
			register: () => registration,
			unregister: () => undefined,
			isDraining: () => false,
			setDraining: () => undefined,
		};

		expect(service.register("mbrooks/tars#1", () => undefined)).toBe(registration);
		expect(service.isActive("mbrooks/tars#1")).toBe(true);
	});
});
