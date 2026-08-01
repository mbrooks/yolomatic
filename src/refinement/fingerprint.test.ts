import { describe, expect, it } from "vitest";
import { fingerprintBody } from "./fingerprint.js";

describe("fingerprintBody", () => {
	it("returns different fingerprints for different bodies", () => {
		const a = fingerprintBody("hello");
		const b = fingerprintBody("world");
		expect(a).not.toBe(b);
	});

	it("returns the same fingerprint for identical bodies", () => {
		const a = fingerprintBody("same body");
		const b = fingerprintBody("same body");
		expect(a).toBe(b);
	});

	it("produces a hex sha256 string", () => {
		const fp = fingerprintBody("test");
		expect(fp).toMatch(/^[a-f0-9]{64}$/u);
	});
});
