import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import ignore from "ignore";
import { homedir } from "os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { parseFrontmatter, stripFrontmatter } from "../utils/frontmatter.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** Max UTF-8 bytes per file when inlining a skill directory into the system prompt. */
const MAX_SKILL_SINGLE_FILE_BYTES = 300_000;
/** Max characters for one skill's combined CDATA (all text files under the skill dir). */
const MAX_SKILL_SEGMENT_TOTAL_CHARS = 200_000;

const SKIP_SKILL_SUBDIR_NAMES = new Set([
	"node_modules",
	".git",
	"__pycache__",
	".venv",
	"venv",
	"dist",
	"build",
	".turbo",
	"coverage",
	"target",
]);

const SKILL_TEXT_FILE_EXTENSIONS = new Set([
	".md",
	".txt",
	".json",
	".yaml",
	".yml",
	".py",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".sh",
	".toml",
	".css",
	".html",
	".htm",
	".svg",
	".xml",
	".csv",
	".sql",
	".graphql",
	".ini",
	".cfg",
	".properties",
]);

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];

	if (name !== parentDirName) {
		errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	}

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, true);
}

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			// Skip node_modules to avoid scanning dependencies
			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch {}

	return { skills, diagnostics };
}

function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		// Validate description
		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Use name from frontmatter, or fall back to parent directory name
		const name = frontmatter.name || parentDirName;

		// Validate name
		const nameErrors = validateName(name, parentDirName);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Still load the skill even with warnings (unless description is completely missing)
		if (!frontmatter.description || frontmatter.description.trim() === "") {
			return { skill: null, diagnostics };
		}

		return {
			skill: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: skillDir,
				sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			},
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}
}

/** Stable segment tag for `<SKILL_*>` (only `[A-Za-z0-9_]`). Use the `name` attribute with skills_context load/unload. */
export function skillPromptSegmentId(skillName: string): string {
	const core = skillName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "skill";
	return `SKILL_${core}`;
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/\r/g, "&#13;");
}

function wrapCdata(text: string): string {
	return `<![CDATA[${text.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

type SkillDirFile = { rel: string; text: string };

function collectSkillDirectoryTextFiles(rootDir: string): SkillDirFile[] {
	if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
		return [];
	}
	const out: SkillDirFile[] = [];
	const walk = (absDir: string): void => {
		for (const ent of readdirSync(absDir, { withFileTypes: true })) {
			const abs = join(absDir, ent.name);
			if (ent.isDirectory()) {
				if (SKIP_SKILL_SUBDIR_NAMES.has(ent.name)) continue;
				walk(abs);
			} else if (ent.isFile()) {
				const rel = relative(rootDir, abs).split(sep).join("/");
				const ext = extname(ent.name).toLowerCase();
				const isSkillMd = ent.name.toUpperCase() === "SKILL.MD";
				if (!isSkillMd && !SKILL_TEXT_FILE_EXTENSIONS.has(ext)) continue;
				try {
					const buf = readFileSync(abs);
					if (buf.length > MAX_SKILL_SINGLE_FILE_BYTES) {
						out.push({
							rel,
							text: `[skipped file: larger than ${MAX_SKILL_SINGLE_FILE_BYTES} bytes]\n`,
						});
						continue;
					}
					out.push({ rel, text: buf.toString("utf8") });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					out.push({ rel, text: `[read error: ${msg}]\n` });
				}
			}
		}
	};
	walk(rootDir);
	out.sort((a, b) => {
		const aSkill = a.rel === "SKILL.md" || a.rel.endsWith("/SKILL.md");
		const bSkill = b.rel === "SKILL.md" || b.rel.endsWith("/SKILL.md");
		if (aSkill && !bSkill) return -1;
		if (!aSkill && bSkill) return 1;
		return a.rel.localeCompare(b.rel);
	});
	return out;
}

function isSkillMdRel(rel: string): boolean {
	return rel === "SKILL.md" || rel.endsWith("/SKILL.md");
}

function formatSingleLoadedSkillSegment(skill: Skill): string {
	const tag = skillPromptSegmentId(skill.name);
	const desc = skill.description.trim().replace(/\s+/g, " ");
	let files = collectSkillDirectoryTextFiles(skill.baseDir);
	if (files.length === 0) {
		try {
			const raw = readFileSync(skill.filePath, "utf-8");
			const rel =
				skill.baseDir && existsSync(skill.baseDir)
					? relative(skill.baseDir, skill.filePath).split(sep).join("/") || "SKILL.md"
					: "SKILL.md";
			files = [{ rel, text: raw }];
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return `<${tag} name="${escapeXmlAttribute(skill.name)}" description="${escapeXmlAttribute(desc)}">${wrapCdata(`[Could not read skill files: ${msg}]`)}</${tag}>`;
		}
	}

	const parts: string[] = [];
	let total = 0;
	for (const f of files) {
		const body = isSkillMdRel(f.rel) ? stripFrontmatter(f.text).trim() : f.text.trim();
		const header = `# file: ${f.rel}\n\n`;
		const segment = header + body;
		if (total + segment.length > MAX_SKILL_SEGMENT_TOTAL_CHARS) {
			parts.push(`[omitted: combined skill text exceeded ${MAX_SKILL_SEGMENT_TOTAL_CHARS} characters]\n`);
			break;
		}
		parts.push(segment);
		total += segment.length;
	}
	const joined = parts.join("\n---\n\n");
	return `<${tag} name="${escapeXmlAttribute(skill.name)}" description="${escapeXmlAttribute(desc)}">${wrapCdata(joined)}</${tag}>`;
}

export type FormatSkillsForPromptOptions = {
	/**
	 * When true, embed each loaded skill under `<LOADED_SKILLS>` as `<SKILL_*>` with CDATA (SKILL.md body plus text files under the skill directory).
	 * Use for skills loaded into the session via skills_context. Default false: one line per skill (catalog).
	 */
	embedBodies?: boolean;
};

/**
 * Format skills for inclusion in a system prompt.
 *
 * - Default (`embedBodies` false): one line per skill (`name: summary`), no disk reads (e.g. Mom catalog).
 * - `embedBodies` true: `<LOADED_SKILLS>` segments with full text bundle per skill (pi session).
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
export function formatSkillsForPrompt(skills: Skill[], options?: FormatSkillsForPromptOptions): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	if (options?.embedBodies !== true) {
		const lines = visibleSkills.map((skill) => {
			const desc = skill.description.trim().replace(/\s+/g, " ");
			return `- ${skill.name}: ${desc}`;
		});
		return `\n\n${lines.join("\n")}`;
	}

	const lines: string[] = [
		"",
		"",
		"<LOADED_SKILLS>",
		"Load or unload using skills_context with the exact value of each block's name attribute (e.g. name=\"my-skill\"). The opening tag (SKILL_*) is a stable segment id for quick reference; tools use the name attribute.",
		"When a skill references a relative path, resolve it against that skill's directory (the folder containing its SKILL.md).",
		"",
	];

	for (const skill of visibleSkills) {
		lines.push(formatSingleLoadedSkillSegment(skill));
		lines.push("");
	}
	lines.push("</LOADED_SKILLS>");

	return lines.join("\n");
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
}

function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	return trimmed;
}

function resolveSkillPath(p: string, cwd: string): string {
	const normalized = normalizePath(p);
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { cwd, agentDir, skillPaths, includeDefaults } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedAgentDir = agentDir ?? getAgentDir();

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			// Resolve symlinks to detect duplicate files
			let realPath: string;
			try {
				realPath = realpathSync(skill.filePath);
			} catch {
				realPath = skill.filePath;
			}

			// Skip silently if we've already loaded this exact file (via symlink)
			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	if (includeDefaults) {
		addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
		addSkills(loadSkillsFromDirInternal(resolve(cwd, CONFIG_DIR_NAME, "skills"), "project", true));
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(cwd, CONFIG_DIR_NAME, "skills");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolveSkillPath(rawPath, cwd);
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
