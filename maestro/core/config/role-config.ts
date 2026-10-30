import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBoolean, isRecord, type JsonValue } from "./type-guards.ts";

export interface RoleConfig {
	/** Accepted no-op settings, each with actionable migration text. */
	deprecations: string[];
}

export interface RoleConfigOptions {
	/**
	 * The host's project configuration directory name (`.omp` under the current
	 * host, `.pi` under pi). The project role directory is
	 * `<cwd>/<configDirName>/agents`. Defaults to `.pi`.
	 */
	configDirName?: string;
}

function invalidRoleConfig(source: string, message: string): never {
	throw new Error(`Invalid subagent role config in ${source}: ${message}`);
}

export function parseRoleConfig(
	rawConfig: JsonValue,
	source = "config.json",
	options: RoleConfigOptions = {},
): RoleConfig {
	const configDirName = options.configDirName ?? ".pi";
	if (!isRecord(rawConfig)) {
		invalidRoleConfig(source, "root must be an object");
	}
	if (!Object.hasOwn(rawConfig, "roles")) return { deprecations: [] };
	const roles = rawConfig.roles;
	if (!isRecord(roles)) {
		invalidRoleConfig(source, "roles must be an object");
	}

	const unsupportedKeys = Object.keys(roles).filter((key) => key !== "bundled");
	if (unsupportedKeys.length > 0) {
		invalidRoleConfig(
			source,
			`roles has unsupported key(s): ${unsupportedKeys.join(", ")}`,
		);
	}
	if (!Object.hasOwn(roles, "bundled")) return { deprecations: [] };
	if (!isBoolean(roles.bundled)) {
		invalidRoleConfig(source, "roles.bundled must be a boolean");
	}
	// The host ships no roles, so both legacy booleans are no-ops. Never rewrite
	// user configuration to remove the key.
	return {
		deprecations: [
			`Deprecated setting roles.bundled (${roles.bundled}) in ${source} is ignored: pi-herdr-agents no longer ships bundled roles. Install a role pack or add global or project definitions for the roles you use (project definitions live in the project's ${configDirName}/agents directory, global ones in the agent config directory's agents folder), then remove roles.bundled. The file was not changed.`,
		],
	};
}

interface RoleConfigSource {
	sourcePath: string;
	rawConfig: string;
}

function readRoleConfigFile(
	configPath: string,
	examplePath: string,
): RoleConfigSource {
	try {
		return {
			sourcePath: configPath,
			rawConfig: readFileSync(configPath, "utf8"),
		};
	} catch (error) {
		// SAFETY: readFileSync only throws Node fs errors here, which carry code.
		const errno = error as NodeJS.ErrnoException;
		if (errno.code !== "ENOENT") throw error;
	}

	try {
		return {
			sourcePath: examplePath,
			rawConfig: readFileSync(examplePath, "utf8"),
		};
	} catch (error) {
		// SAFETY: see the preceding readFileSync error handling.
		const errno = error as NodeJS.ErrnoException;
		if (errno.code === "ENOENT") {
			throw new Error(
				`Missing subagent role config. Expected ${configPath} or ${examplePath}.`,
			);
		}
		throw error;
	}
}

export function loadRoleConfig(
	configDir: string,
	examplePath: string,
	options: RoleConfigOptions = {},
): RoleConfig {
	const configPath = join(configDir, "config.json");
	const { sourcePath, rawConfig } = readRoleConfigFile(configPath, examplePath);
	let parsed;
	try {
		parsed = JSON.parse(rawConfig);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
	}
	return parseRoleConfig(parsed, sourcePath, options);
}
