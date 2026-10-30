import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The host's agent configuration directory.
 *
 * `PI_CODING_AGENT_DIR` wins, exactly like the host itself; otherwise the
 * directory comes from the host SDK, so this is `~/.omp/agent` under omp and
 * `~/.pi/agent` under the pi SDK.
 */
export function getAgentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
}

/**
 * The host's configuration directory name: `.omp` under omp, `.pi` under the
 * pi SDK. Callers use it to locate per-project host directories such as
 * `<cwd>/<configDirName>/agents` instead of hardcoding one spelling.
 */
export function getConfigDirName(): string {
	return CONFIG_DIR_NAME;
}

export function getSubagentsConfigDir(): string {
	return join(getAgentConfigDir(), "herdr-agents");
}

export function getSubagentsConfigPath(): string {
	return join(getSubagentsConfigDir(), "config.json");
}

export function getSubagentsConfigExamplePath(): string {
	return join(PACKAGE_ROOT, "config.json.example");
}

export function getSubagentsPackageRoot(): string {
	return PACKAGE_ROOT;
}
