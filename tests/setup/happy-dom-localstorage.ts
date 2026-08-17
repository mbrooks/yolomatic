/**
 * Vitest setup: restore a working `localStorage` in the happy-dom environment.
 *
 * Node 22+ ships an experimental native `localStorage` global. Vitest's
 * happy-dom environment populates `globalThis` from the happy-dom `Window`,
 * but its `getWindowKeys` helper skips any key that already exists on
 * `globalThis` unless it is in the hard-coded DOM key allowlist. Because
 * `localStorage` is not in that allowlist and Node already defines it (as an
 * experimental accessor that returns `undefined` until a `--localstorage-file`
 * is configured), happy-dom's `Storage` instance never gets installed. The
 * result is `typeof localStorage === "undefined"` inside happy-dom tests on
 * modern Node, which breaks any browser-oriented code that reads or writes
 * `localStorage` (for example the onboarding wizard).
 *
 * This setup file runs after the environment is initialized. When a DOM
 * environment is active but `localStorage` is missing a working `Storage`,
 * install a fresh happy-dom `Storage` on `globalThis` so browser-style code
 * under test behaves as expected. Node-environment tests are left untouched.
 */
import { Storage } from "happy-dom";

const existing = (globalThis as { localStorage?: Storage | undefined }).localStorage;
const needsStorage =
	typeof document !== "undefined" &&
	(existing === undefined ||
		typeof existing?.getItem !== "function" ||
		typeof existing?.setItem !== "function" ||
		typeof existing?.removeItem !== "function" ||
		typeof existing?.clear !== "function");

if (needsStorage) {
	const store = new Storage();
	Object.defineProperty(globalThis, "localStorage", {
		value: store,
		configurable: true,
		writable: true,
	});
}