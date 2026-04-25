import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_TIMEOUT_MINUTES,
	MAX_TIMEOUT_MINUTES,
	MIN_TIMEOUT_MINUTES,
	SessionTimer,
	TimeoutError,
} from "./timer.js";

describe("TimeoutError", () => {
	it("formats message with elapsed minutes", () => {
		const error = new TimeoutError(15 * 60 * 1000, 30 * 60 * 1000);
		expect(error.message).toBe("⏱️ Session timed out after 15 minutes");
		expect(error.name).toBe("TimeoutError");
		expect(error.elapsedMs).toBe(15 * 60 * 1000);
		expect(error.limitMs).toBe(30 * 60 * 1000);
	});
});

describe("SessionTimer", () => {
	it("uses the provided timeout", () => {
		const timer = new SessionTimer(15);
		expect(timer.limitMinutes).toBe(15);
	});

	it("defaults to 30 minutes", () => {
		const timer = new SessionTimer(DEFAULT_TIMEOUT_MINUTES);
		expect(timer.limitMinutes).toBe(30);
	});

	it("clamps below minimum to 5 minutes and logs a warning", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const timer = new SessionTimer(2);
		expect(timer.limitMinutes).toBe(MIN_TIMEOUT_MINUTES);
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("clamped"));
		stderrSpy.mockRestore();
	});

	it("clamps above maximum to 60 minutes and logs a warning", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const timer = new SessionTimer(90);
		expect(timer.limitMinutes).toBe(MAX_TIMEOUT_MINUTES);
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("clamped"));
		stderrSpy.mockRestore();
	});

	it("returns ok when timer has not started", () => {
		const timer = new SessionTimer(30);
		expect(timer.check().status).toBe("ok");
		expect(timer.isExpired()).toBe(false);
		expect(timer.budgetUsedFraction()).toBe(0);
	});

	it("tracks remaining time after start", () => {
		let currentTime = 1000;
		const timer = new SessionTimer(30, () => currentTime);
		timer.start();
		expect(timer.remainingMs()).toBe(30 * 60 * 1000);
		currentTime = 61000;
		expect(timer.remainingMs()).toBe(29 * 60 * 1000);
	});

	it("expires after the limit is reached", () => {
		let currentTime = 0;
		const timer = new SessionTimer(5, () => currentTime);
		timer.start();
		expect(timer.isExpired()).toBe(false);
		currentTime = 5 * 60 * 1000;
		expect(timer.isExpired()).toBe(true);
		expect(timer.check().status).toBe("expired");
	});

	it("emits 50% warning once", () => {
		let currentTime = 0;
		const timer = new SessionTimer(10, () => currentTime);
		timer.start();
		currentTime = 5 * 60 * 1000; // 50%
		const result = timer.check();
		expect(result.status).toBe("warning");
		expect(result.warnings).toEqual(["⏳ Half of session budget used."]);
		// Second check should not repeat
		expect(timer.check().status).toBe("ok");
	});

	it("emits all three warnings in order", () => {
		let currentTime = 0;
		const timer = new SessionTimer(60, () => currentTime);
		timer.start();

		currentTime = 30 * 60 * 1000; // 50% of 60
		expect(timer.consumeWarnings()).toEqual(["⏳ Half of session budget used."]);

		currentTime = 45 * 60 * 1000; // 75% of 60
		expect(timer.consumeWarnings()).toEqual(["⏳ 25% budget remaining — focusing on essentials."]);

		currentTime = 54 * 60 * 1000; // 90% of 60
		expect(timer.consumeWarnings()).toEqual(["⏳ 10% budget remaining — attempting to wrap up cleanly."]);

		// After 90%, still expired eventually
		currentTime = 60 * 60 * 1000; // 100%
		expect(timer.check().status).toBe("expired");
	});

	it("calculates budgetUsedFraction correctly", () => {
		let currentTime = 0;
		const timer = new SessionTimer(10, () => currentTime);
		timer.start();
		currentTime = 3000;
		// 3s / 600s = 0.005
		expect(timer.budgetUsedFraction()).toBeCloseTo(3 / 600, 4);
	});
});
