import { describe, expect, it } from "vitest";

import { TaskController } from "./task-controller.js";

describe("TaskController", () => {
	it("registers and cancels an active task, keeping the key claimed until unregister", () => {
		const controller = new TaskController();
		let aborted = false;
		const registration = controller.register("key1", () => {
			aborted = true;
		});

		expect(controller.isActive("key1")).toBe(true);
		expect(controller.cancel("key1")).toBe(true);
		expect(aborted).toBe(true);
		// The key stays claimed during wind-down so concurrent events steer/queue
		// instead of starting a new worker as a side effect of the cancel.
		expect(controller.isActive("key1")).toBe(true);
		controller.unregister("key1", registration!);
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
		const registration = controller.register("key1", () => {
			aborted = true;
		});
		expect(registration).not.toBeNull();
		controller.unregister("key1", registration!);
		expect(controller.isActive("key1")).toBe(false);
		expect(controller.cancel("key1")).toBe(false);
		expect(aborted).toBe(false);
	});

	it("refuses to overwrite an active task", () => {
		const controller = new TaskController();
		const first = controller.register("key1", () => {});
		const second = controller.register("key1", () => {});

		expect(first).not.toBeNull();
		expect(second).toBeNull();
		expect(controller.isActive("key1")).toBe(true);
	});

	it("keeps a cancelled task claimed so a replacement cannot register during wind-down", () => {
		const controller = new TaskController();
		const first = controller.register("key1", () => {});
		expect(first).not.toBeNull();
		expect(controller.cancel("key1")).toBe(true);

		// A new registration is refused while the winding-down task is still claimed.
		const replacement = controller.register("key1", () => {});
		expect(replacement).toBeNull();
		expect(controller.isActive("key1")).toBe(true);

		// The key frees once the winding-down run's finally block unregisters.
		controller.unregister("key1", first!);
		expect(controller.isActive("key1")).toBe(false);

		// After wind-down, a new registration can claim the key again.
		const replacement2 = controller.register("key1", () => {});
		expect(replacement2).not.toBeNull();
		controller.unregister("key1", replacement2!);
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
