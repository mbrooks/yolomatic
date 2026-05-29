import { readFile } from "node:fs/promises";
import type { Patch } from "./types.js";

export class PatchGenerator {
	async generate(filePath: string, errorMessage: string, _errorStack?: string): Promise<Patch | null> {
		let original: string;
		try {
			original = await readFile(filePath, "utf-8");
		} catch {
			return null;
		}

		let patched = original;

		const propMatch = /Cannot read properties of undefined \(reading '(\w+)'\)/.exec(errorMessage);
		if (propMatch) {
			const prop = propMatch[1];
			const regex = new RegExp(`\\.${prop}(?![a-zA-Z0-9_])`, "g");
			patched = original.replace(regex, `?.${prop}`);
		}

		if (patched === original) {
			return null;
		}

		const diff = this.computeDiff(filePath, original, patched);
		return { filePath, originalContent: original, patchedContent: patched, diff };
	}

	private computeDiff(filePath: string, original: string, patched: string): string {
		const origLines = original.split("\n");
		const patchLines = patched.split("\n");
		let diff = `--- ${filePath}\n+++ ${filePath}\n`;
		const max = Math.max(origLines.length, patchLines.length);
		for (let i = 0; i < max; i += 1) {
			const a = origLines[i];
			const b = patchLines[i];
			if (a === undefined && b !== undefined) {
				diff += `+${b}\n`;
			} else if (b === undefined && a !== undefined) {
				diff += `-${a}\n`;
			} else if (a !== b) {
				diff += `-${a}\n+${b}\n`;
			}
		}
		return diff;
	}
}
