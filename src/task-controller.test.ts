import { describe, expect, it } from "vitest";

import { TaskController } from "./task-controller.js";

describe("TaskController", () => {
	it("registers and cancels an active task", () => {
		const controller = new TaskController();
		let aborted = false;
		controller.register("key1", () => {
			aborted = true;
		});

		expect(controller.isActive("key1")).toBe(true);
		expect(controller.cancel("key1")).toBe(true);
		expect(aborted).toBe(true);
		expect(controller.isActive("key1")).toBe(false);
	});

	it("returns false when cancelling a non-existent key", () => {
		const controller = new TaskController();
		expect(controller.cancel("missing")).toBe(false);
		expect(controller.isActive("missing")).toBe(false);
	});

	it("unregisters a task without invoking abort", () => {
		const controller = new TaskController();
		let aborted = false;
		controller.register("key1", () => {
			aborted = true;
		});
		controller.unregister("key1");
		expect(controller.isActive("key1")).toBe(false);
		expect(controller.cancel("key1")).toBe(false);
		expect(aborted).toBe(false);
	});

	it("tracks multiple tasks independently", () => {
		const controller = new TaskController();
		const log: string[] = [];
		controller.register("a", () => log.push("a"));
		controller.register("b", () => log.push("b"));

		expect(controller.cancel("a")).toBe(true);
		expect(log).toEqual(["a"]);
		expect(controller.isActive("b")).toBe(true);
	});
});
