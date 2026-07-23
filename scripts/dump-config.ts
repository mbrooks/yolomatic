#!/usr/bin/env -S npx tsx

import "dotenv/config";

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	SETTING_DEFINITIONS,
	coerceEnvValue,
	parseSettingValue,
} from "../src/settings/model.js";
import { SettingsStore } from "../src/settings/store.js";

type SettingReader = Pick<SettingsStore, "get">;
type DumpValue = string | number | boolean | null;

export function getEffectiveSettings(
	store: SettingReader,
	env: NodeJS.ProcessEnv,
): Record<string, DumpValue> {
	const values: Record<string, DumpValue> = {};

	for (const definition of SETTING_DEFINITIONS) {
		let raw = store.get(definition.key);
		if (raw === undefined) {
			const envValue = env[definition.envVar]?.trim();
			raw = envValue ? coerceEnvValue(definition.key, envValue) : undefined;
		}
		raw ??= definition.default;

		if (raw === undefined) {
			values[definition.key] = null;
		} else {
			values[definition.key] = parseSettingValue(definition, raw);
		}
	}

	return values;
}

function main(): void {
	const explicitDbPath = process.argv[2];
	const memoryDir = path.resolve(process.env.MEMORY_DIR?.trim() || path.join(process.cwd(), "memory"));
	const dbPath = path.resolve(explicitDbPath || path.join(memoryDir, "bot-state.sqlite"));

	if (!existsSync(dbPath)) {
		throw new Error(`Settings database not found: ${dbPath}`);
	}

	const store = new SettingsStore(dbPath);
	const dump = {
		settingsDatabase: dbPath,
		settings: getEffectiveSettings(store, process.env),
	};
	process.stdout.write(`${JSON.stringify(dump, null, 2)}\n`);
}

/* v8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
/* v8 ignore stop */
