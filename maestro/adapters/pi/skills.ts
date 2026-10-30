import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import {
	CONFIG_DIR_NAME,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	isRecord,
	isString,
	type JsonObject,
	type JsonValue,
} from "../../core/config/type-guards.ts";

/**
 * Delivering a role's declared skills with a child's first task.
 *
 * A standalone child cannot receive skills through `/skill:name` arguments:
 * the host binds `@file` to the first prompt and expands one slash command
 * per message, so the skills land in later turns or not at all. The host
 * instead reads each declared skill's body and writes it into the task
 * artifact.
 *
 * Discovery here only reads files. It never builds a resource loader, imports
 * an extension, runs a package manager or spawns a process, so resolving
 * skills for a child's cwd cannot run that project's code inside the parent.
 * It reads the same skill roots the host's own loader reads, in the host's
 * precedence order:
 *
 * 1. project `skills` entries from `<cwd>/<configDirName>/settings.json`
 *    (plain paths)
 * 2. `<cwd>/<configDirName>/skills` and `.agents/skills` in cwd and each
 *    ancestor up to the Git root
 * 3. user `skills` entries from `<agentDir>/settings.json` (plain paths)
 * 4. `<agentDir>/skills` and `~/.agents/skills`
 * 5. skills of configured packages (project, then user) whose install
 *    directory already exists; a package that is not installed is skipped
 *
 * The reader is local on purpose. The host SDKs disagree about skill
 * loading: one exposes a synchronous loader over every skill root, the other
 * an asynchronous loader with a different option set, a different result
 * shape and different discovery rules. A local reader gives both hosts one
 * behaviour, one shape and no host-specific import at this seam.
 */

/** Largest SKILL.md file delivered with a task. */
export const SKILL_FILE_MAX_BYTES = 64 * 1024;
/** Largest combined size of all skill blocks delivered with one task. */
export const SKILLS_TOTAL_MAX_BYTES = 256 * 1024;

/** One declared skill resolved to the instruction body delivered with a task. */
export interface ResolvedSkill {
	name: string;
	filePath: string;
	baseDir: string;
	content: string;
}

export interface SkillResolution {
	skills: ResolvedSkill[];
	/** Declared names that resolved to no discovered skill. */
	missing: string[];
	/** Host diagnostics for the parent, each naming the skill it concerns. */
	diagnostics: string[];
}

export interface SkillResolveOptions {
	/** The child's working directory. */
	cwd: string;
	/** The child's effective host agent directory. */
	agentDir: string;
	/** Home directory for `~/.agents/skills`; defaults to `$HOME`. */
	homeDir?: string;
	/**
	 * The host's project configuration directory name (`.omp` under the
	 * current host, `.pi` under pi). Defaults to the host SDK's own value.
	 */
	configDirName?: string;
}

/** Resolve declared skill names to their instruction bodies. */
export type SkillResolver = (
	names: readonly string[],
	options: SkillResolveOptions,
) => SkillResolution | Promise<SkillResolution>;

/** A declared skill cannot be delivered within the size limits. */
export class SkillDeliveryError extends Error {
	override name = "SkillDeliveryError";
}

/** Split a comma-separated `skills` declaration, keeping first occurrences. */
export function parseDeclaredSkills(value: string | undefined): string[] {
	const names = (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	return [...new Set(names)];
}

/**
 * Resolve declared skills by exact name among the skills discovered on disk.
 * A name never becomes a path; path-like names resolve to nothing.
 */
export function resolveDeclaredSkills(
	names: readonly string[],
	options: SkillResolveOptions,
): SkillResolution {
	const declared = [...new Set(names.map((name) => name.trim()))].filter(
		Boolean,
	);
	if (declared.length === 0)
		return { skills: [], missing: [], diagnostics: [] };

	const search = collectSkillSearch(options);
	const discovered = discoverSkills(search);
	const skills: ResolvedSkill[] = [];
	const missing: string[] = [];
	const diagnostics: string[] = [];
	for (const name of declared) {
		const skill = isSkillName(name) ? discovered.get(name) : undefined;
		if (!skill) {
			missing.push(name);
			continue;
		}
		if (skill.size > SKILL_FILE_MAX_BYTES) {
			throw new SkillDeliveryError(
				`Skill "${name}" (${skill.filePath}) is ${formatKiB(skill.size)}, over the ` +
					`${formatKiB(SKILL_FILE_MAX_BYTES)} per-skill limit for delivery with a ` +
					`subagent's first task. Shorten it (move detail into files the skill ` +
					`references) or remove "${name}" from the role's skills.`,
			);
		}
		skills.push({
			name,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			content: skill.body.trim(),
		});
	}

	const total = Buffer.byteLength(formatSkillBlocks(skills));
	if (total > SKILLS_TOTAL_MAX_BYTES) {
		throw new SkillDeliveryError(
			`Declared skills ${skills.map((skill) => `"${skill.name}"`).join(", ")} ` +
				`total ${formatKiB(total)}, over the ${formatKiB(SKILLS_TOTAL_MAX_BYTES)} ` +
				`total limit for delivery with a subagent's first task. Declare fewer ` +
				`skills for this role or shorten them.`,
		);
	}

	if (missing.length > 0) {
		const quoted = missing.map((name) => `"${name}"`).join(", ");
		diagnostics.push(
			`Declared skill${missing.length === 1 ? "" : "s"} ${quoted} ` +
				`${missing.length === 1 ? "was" : "were"} not found on disk and ` +
				`${missing.length === 1 ? "was" : "were"} not delivered` +
				(search.notes.length > 0 ? ` (${search.notes.join("; ")})` : ""),
		);
	}
	return { skills, missing, diagnostics };
}

/** Format resolved skills as the `<skill>` blocks the host injects. */
export function formatSkillBlocks(skills: readonly ResolvedSkill[]): string {
	return skills
		.map(
			(skill) =>
				`<skill name="${skill.name}" location="${skill.filePath}">\n` +
				`References are relative to ${skill.baseDir}.\n\n` +
				`${skill.content}\n</skill>`,
		)
		.join("\n\n");
}

/** A note for the child naming declared skills the host could not find. */
export function formatMissingSkillsNote(missing: readonly string[]): string {
	return missing.length > 0
		? `Declared skills not found: ${missing.join(", ")}. They were not loaded.`
		: "";
}

interface SkillSearch {
	/** Skill roots and files in precedence order. */
	paths: string[];
	/** Sources that were not searched, for missing-skill diagnostics. */
	notes: string[];
}

type PackageScope = "project" | "user";

/** One `packages` settings entry, parsed at the settings-file boundary. */
interface PackageEntry {
	source: string;
	/** An object entry with `skills: []` disables the package's skills. */
	skillsDisabled: boolean;
}

/** The settings fields skill discovery reads. */
interface SettingsView {
	skills: string[];
	packages: PackageEntry[];
}

/** Where a configured package's skills live, or why they were not searched. */
interface PackageLocation {
	root?: string;
	note?: string;
}

/** One skill file found on disk, with the frontmatter the host needs. */
interface DiscoveredSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	/** The file's size in bytes. */
	size: number;
	/** The file body without its frontmatter. */
	body: string;
}

function collectSkillSearch(options: SkillResolveOptions): SkillSearch {
	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir);
	const home = resolve(options.homeDir ?? (process.env.HOME || homedir()));
	const configDirName = options.configDirName ?? CONFIG_DIR_NAME;
	const projectBase = join(cwd, configDirName);
	const global = readSettings(join(agentDir, "settings.json"));
	const project = readSettings(join(projectBase, "settings.json"));
	const homeAgentsSkills = join(home, ".agents", "skills");
	const search: SkillSearch = { paths: [], notes: [] };

	search.paths.push(...settingsSkillPaths(project.skills, projectBase, home));
	search.paths.push(join(projectBase, "skills"));
	for (const dir of ancestorAgentsSkillDirs(cwd)) {
		if (dir === homeAgentsSkills) continue;
		search.paths.push(dir);
	}
	search.paths.push(...settingsSkillPaths(global.skills, agentDir, home));
	search.paths.push(join(agentDir, "skills"), homeAgentsSkills);

	const packages = [
		...project.packages.map((entry) => ({ entry, scope: "project" as const })),
		...global.packages.map((entry) => ({ entry, scope: "user" as const })),
	];
	for (const { entry, scope } of packages) {
		if (entry.skillsDisabled) continue;
		const located = locatePackage(entry.source, scope, {
			installBase: scope === "project" ? projectBase : agentDir,
			home,
		});
		if (located.root) search.paths.push(...packageSkillPaths(located.root));
		else if (located.note) search.notes.push(located.note);
	}
	return search;
}

/** Discover skills on disk; the first skill with a name wins. */
function discoverSkills(search: SkillSearch): Map<string, DiscoveredSkill> {
	const byName = new Map<string, DiscoveredSkill>();
	const seenFiles = new Set<string>();
	for (const path of search.paths) {
		if (!existsSync(path)) continue;
		for (const filePath of skillFilesIn(path)) {
			const skill = readSkillFile(filePath);
			if (!skill) continue;
			const canonical = canonicalPath(skill.filePath);
			if (seenFiles.has(canonical) || byName.has(skill.name)) continue;
			seenFiles.add(canonical);
			byName.set(skill.name, skill);
		}
	}
	return byName;
}

/**
 * The skill files one search path contributes: the `SKILL.md` of every
 * skill directory under a root, or the file itself when a settings entry
 * names a markdown file.
 */
function skillFilesIn(path: string): string[] {
	if (!isDirectory(path)) {
		return path.endsWith(".md") ? [path] : [];
	}
	let entries;
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		if (entry.name.startsWith(".")) continue;
		if (entry.name === "node_modules") continue;
		const dir = join(path, entry.name);
		if (!isDirectory(dir)) continue;
		const file = join(dir, "SKILL.md");
		if (existsSync(file)) files.push(file);
	}
	return files;
}

/** Read one skill file's frontmatter and body. */
function readSkillFile(filePath: string): DiscoveredSkill | undefined {
	let size: number;
	try {
		size = statSync(filePath).size;
	} catch {
		return undefined;
	}
	const text = readSkillText(filePath, size);
	if (text === undefined) return undefined;
	let frontmatter: JsonObject;
	let body: string;
	try {
		const parsed = parseFrontmatter<JsonObject>(text);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch {
		return undefined;
	}
	if (frontmatter.enabled === false) return undefined;
	const description = isString(frontmatter.description)
		? frontmatter.description.trim()
		: "";
	if (!description) return undefined;
	const baseDir = dirname(filePath);
	const declared = isString(frontmatter.name) ? frontmatter.name.trim() : "";
	const name = declared || basename(baseDir);
	if (name.includes("/") || name.includes("\\")) return undefined;
	return { name, description, filePath, baseDir, size, body };
}

/**
 * Read a skill file's text. A file over the size limit is read as a head
 * only, so its frontmatter can still name it without loading it whole; its
 * body is empty and the size check refuses to deliver it.
 */
function readSkillText(filePath: string, size: number): string | undefined {
	try {
		if (size <= SKILL_FILE_MAX_BYTES) return readFileSync(filePath, "utf8");
		const handle = openSync(filePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(SKILL_FILE_MAX_BYTES);
			const read = readSync(handle, buffer, 0, buffer.length, 0);
			return buffer.subarray(0, read).toString("utf8");
		} finally {
			closeSync(handle);
		}
	} catch {
		return undefined;
	}
}

/** Declared names are names, never paths. */
function isSkillName(name: string): boolean {
	return (
		!name.includes("/") &&
		!name.includes("\\") &&
		!name.includes("\0") &&
		!name.includes("..") &&
		!isAbsolute(name)
	);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function ancestorAgentsSkillDirs(cwd: string): string[] {
	const gitRoot = findGitRoot(cwd);
	const dirs: string[] = [];
	let dir = cwd;
	while (true) {
		dirs.push(join(dir, ".agents", "skills"));
		if (gitRoot && dir === gitRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function findGitRoot(start: string): string | undefined {
	let dir = start;
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Plain `skills` settings entries; include/exclude patterns are not paths. */
function settingsSkillPaths(
	entries: readonly string[],
	base: string,
	home: string,
): string[] {
	return entries
		.map((entry) => entry.trim())
		.filter((entry) => entry && !/^[!+-]/.test(entry) && !hasGlob(entry))
		.map((entry) => resolve(base, expandHome(entry, home)));
}

/**
 * Find an already-installed package directory by the host's install layout.
 * Nothing is installed, updated or executed; legacy global npm roots, which
 * need an `npm root -g` process to locate, are not searched.
 */
function locatePackage(
	source: string,
	scope: PackageScope,
	context: { installBase: string; home: string },
): PackageLocation {
	const location: PackageLocation = {};
	const path = packageInstallPath(source, context);
	if (!path) {
		location.note = `package ${source} (${scope}) could not be located`;
		return location;
	}
	try {
		// A package that is a single file contributes no skills.
		if (statSync(path).isDirectory()) location.root = path;
	} catch {
		location.note = `package ${source} (${scope}) is not installed at ${path}, so its skills were not searched`;
	}
	return location;
}

function packageInstallPath(
	source: string,
	context: { installBase: string; home: string },
): string | undefined {
	if (source.startsWith("npm:")) {
		const name = source
			.slice("npm:".length)
			.trim()
			.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1];
		if (!name) return undefined;
		return containedPath(
			join(context.installBase, "npm", "node_modules"),
			name.split("/"),
		);
	}
	const git = parseGitSource(source);
	if (git) {
		return containedPath(join(context.installBase, "git"), [
			git.host,
			...git.path.split("/"),
		]);
	}
	if (/^(git|github|https?|ssh|builtin):/.test(source)) return undefined;
	return resolve(context.installBase, expandHome(source, context.home));
}

/** The host and repository path the host uses for a git package's install dir. */
function parseGitSource(
	source: string,
): { host: string; path: string } | undefined {
	const prefixed = source.startsWith("git:");
	const url = prefixed ? source.slice("git:".length).trim() : source;
	const hasProtocol = /^(https?|ssh|git):\/\//i.test(url);
	if (!prefixed && !hasProtocol) return undefined;
	let host: string;
	let path: string;
	const scp = url.match(/^git@([^:]+):(.+)$/);
	if (scp) {
		host = scp[1];
		path = scp[2];
	} else if (hasProtocol) {
		try {
			const parsed = new URL(url);
			host = parsed.hostname;
			path = parsed.pathname;
		} catch {
			return undefined;
		}
	} else {
		const slash = url.indexOf("/");
		if (slash < 0) return undefined;
		host = url.slice(0, slash);
		path = url.slice(slash + 1);
	}
	path = path.replace(/^\/+/, "");
	const ref = path.indexOf("@");
	if (ref >= 0) path = path.slice(0, ref);
	path = path.replace(/\.git$/, "");
	const parts = path.split("/");
	if (!host || parts.length < 2) return undefined;
	return { host, path };
}

/**
 * Skill paths a package contributes.
 *
 * A package's own manifest key decides the layout: the current host's key
 * (`omp`) keeps skills in the package's `skills` directory unless the
 * manifest names them, while the legacy key (`pi`) names them in the
 * manifest and contributes nothing when it does not. A package with no
 * manifest contributes its `skills` directory.
 */
function packageSkillPaths(root: string): string[] {
	const pkg = readJsonObject(join(root, "package.json"));
	const omp = pkg?.omp;
	if (isRecord(omp)) {
		return declaredSkillPaths(root, omp.skills) ?? [join(root, "skills")];
	}
	const pi = pkg?.pi;
	if (isRecord(pi)) return declaredSkillPaths(root, pi.skills) ?? [];
	return [join(root, "skills")];
}

/** The manifest's named skill paths, or undefined when it names none. */
function declaredSkillPaths(
	root: string,
	entries: JsonValue | undefined,
): string[] | undefined {
	if (!Array.isArray(entries)) return undefined;
	const paths: string[] = [];
	for (const entry of entries) {
		if (!isString(entry) || /^[!+-]/.test(entry) || hasGlob(entry)) continue;
		const path = containedPath(root, [entry]);
		if (path) paths.push(path);
	}
	return paths;
}

/** Join under a root, refusing any result outside it. */
function containedPath(
	root: string,
	parts: readonly string[],
): string | undefined {
	if (parts.some((part) => part.includes("\0") || part.includes("\\"))) {
		return undefined;
	}
	const path = resolve(root, ...parts);
	const rel = relative(root, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? path : undefined;
}

function readSettings(file: string): SettingsView {
	const data = readJsonObject(file);
	const settings: SettingsView = { skills: [], packages: [] };
	if (Array.isArray(data?.skills))
		settings.skills = data.skills.filter(isString);
	if (Array.isArray(data?.packages)) {
		for (const entry of data.packages) {
			if (isString(entry)) {
				settings.packages.push({ source: entry.trim(), skillsDisabled: false });
			} else if (isRecord(entry) && isString(entry.source)) {
				settings.packages.push({
					source: entry.source.trim(),
					skillsDisabled:
						Array.isArray(entry.skills) && entry.skills.length === 0,
				});
			}
		}
	}
	return settings;
}

function readJsonObject(file: string): JsonObject | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function hasGlob(value: string): boolean {
	return /[*?[\]{}]/.test(value);
}

function expandHome(value: string, home: string): string {
	if (value === "~") return home;
	return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function formatKiB(bytes: number): string {
	const kib = bytes / 1024;
	return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
}
