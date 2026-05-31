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

	it("steers an active task", async () => {
		const controller = new TaskController();
		let steered = false;
		controller.register("key1", () => {}, async () => {
			steered = true;
		});

		const result = await controller.steer("key1", "hello");
		expect(result).toBe(true);
		expect(steered).toBe(true);
	});

	it("returns false when steering a non-existent key", async () => {
		const controller = new TaskController();
		const result = await controller.steer("missing", "hello");
		expect(result).toBe(false);
	});

	it("returns false when steering a task without a steer callback", async () => {
		const controller = new TaskController();
		controller.register("key1", () => {});
		const result = await controller.steer("key1", "hello");
		expect(result).toBe(false);
	});

	it("supports draining mode", () => {
		const controller = new TaskController();
		expect(controller.isDraining()).toBe(false);
		controller.setDraining(true);
		expect(controller.isDraining()).toBe(true);
		controller.setDraining(false);
		expect(controller.isDraining()).toBe(false);
	});
});
