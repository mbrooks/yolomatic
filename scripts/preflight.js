import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const requiredTools = [
	["vitest", "tests"],
	["tsc", "TypeScript compilation"],
	["vite", "admin UI build"],
];

const nodeModulesDir = resolve(repoRoot, "node_modules");
const hasNodeModules = existsSync(nodeModulesDir);

const missing = requiredTools.filter(
	([tool]) => !existsSync(resolve(nodeModulesDir, ".bin", tool)),
);

if (missing.length === 0) {
	process.exit(0);
}

const names = missing.map(([tool]) => tool).join(", ");
const reasons = missing.map(([, reason]) => reason).join(", ");

process.stderr.write(
	`ERROR: Required tools are missing from node_modules/.bin: ${names}\n`,
);
process.stderr.write(
	`Needed for: ${reasons}\n`,
);

if (hasNodeModules) {
	// node_modules exists but dev tooling is absent. This commonly happens
	// when npm installs in a NODE_ENV=production environment, which skips
	// devDependencies by default.
	process.stderr.write(
		"Run `npm install --include=dev` to install development dependencies, then retry this command.\n",
	);
} else {
	process.stderr.write(
		"Run `npm install` to install dependencies, then retry this command.\n",
	);
}

process.exit(1);
