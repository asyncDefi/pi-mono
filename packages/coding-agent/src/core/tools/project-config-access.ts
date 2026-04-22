import path from "node:path";
import { CONFIG_DIR_NAME } from "../../config.js";

const BLOCKED_PATH_MESSAGE =
	`Access to the project pi config directory ("${CONFIG_DIR_NAME}" under the session working directory) is not allowed via this tool. ` +
	`Use the skills system, /skill commands, or other supported flows instead of reading or editing files there.`;

const BASH_BLOCKED_PROJECT_CONFIG_MESSAGE =
	`This bash command was rejected because it appears to reference the project pi config directory ("${CONFIG_DIR_NAME}") as a path. ` +
	`Shell access to that folder is not allowed; use the skills system, /skill commands, or the read/find/grep tools for other project files.`;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Heuristic: true if the shell command string appears to use CONFIG_DIR_NAME as a path segment
 * (e.g. `.pi/`, `./.pi`, `/abs/.pi`, `cd .pi`).
 */
export function bashCommandReferencesProjectConfigPath(command: string): boolean {
	const d = escapeRegExp(CONFIG_DIR_NAME);
	const delim = `[\\s"'=(;|&\\x60]`;
	const after = `(?:[/\\\\]|$|[\\s"'):;|&\\x60]|\\n)`;
	const re = new RegExp(
		`(?:^|${delim})\\./${d}${after}` +
			`|(?:^|${delim})\\.\\./${d}${after}` +
			`|[/\\\\]${d}${after}` +
			`|(?:^|${delim})${d}${after}`,
	);
	return re.test(command);
}

/**
 * Rejects bash/shell commands that appear to touch the project config directory path.
 */
export function assertBashCommandAllowedForProjectConfig(command: string): void {
	if (bashCommandReferencesProjectConfigPath(command)) {
		throw new Error(BASH_BLOCKED_PROJECT_CONFIG_MESSAGE);
	}
}

/**
 * Absolute path to the project-local pi config directory for the given session cwd
 * (default folder name from CONFIG_DIR_NAME, e.g. `.pi/`).
 */
export function getProjectConfigRoot(cwd: string): string {
	return path.resolve(cwd, CONFIG_DIR_NAME);
}

/**
 * True if `absolutePath` resolves to the project config root or a path inside it.
 */
export function isPathInsideProjectConfig(absolutePath: string, cwd: string): boolean {
	const root = getProjectConfigRoot(cwd);
	const resolved = path.resolve(absolutePath);
	const rel = path.relative(root, resolved);
	if (rel === "") {
		return true;
	}
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Throws if the path is the project config directory or contained in it.
 */
export function assertPathAllowedForProjectConfig(absolutePath: string, cwd: string): void {
	if (isPathInsideProjectConfig(absolutePath, cwd)) {
		throw new Error(BLOCKED_PATH_MESSAGE);
	}
}

/**
 * When searching from `searchPath`, if the project config tree lies strictly under that root,
 * returns relative POSIX segments from search root to the config root, else `null`.
 * Caller must reject when the search root itself is inside the config dir.
 */
export function getProjectConfigRelativeToSearchRoot(searchPath: string, cwd: string): string | null {
	const blockedRoot = getProjectConfigRoot(cwd);
	const searchResolved = path.resolve(searchPath);
	if (isPathInsideProjectConfig(searchResolved, cwd)) {
		return null;
	}
	const rel = path.relative(searchResolved, blockedRoot);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		return null;
	}
	return rel.split(path.sep).join("/");
}

/** Globs for ripgrep `--glob` (each value is the full glob, e.g. `!.pi/**`). */
export function getRipgrepProjectConfigExcludeGlobs(searchPath: string, cwd: string): string[] {
	const posixRel = getProjectConfigRelativeToSearchRoot(searchPath, cwd);
	if (!posixRel) {
		return [];
	}
	return [`!${posixRel}/**`, `!${posixRel}`];
}

/** Patterns for fd `-E` / `--exclude`. */
export function getFdProjectConfigExcludePatterns(searchPath: string, cwd: string): string[] {
	const posixRel = getProjectConfigRelativeToSearchRoot(searchPath, cwd);
	if (!posixRel) {
		return [];
	}
	return [`${posixRel}`, `${posixRel}/**`];
}

/** Extra ignore globs for the custom `glob()` branch of the find tool. */
export function getFindCustomGlobProjectConfigIgnores(searchPath: string, cwd: string): string[] {
	const posixRel = getProjectConfigRelativeToSearchRoot(searchPath, cwd);
	if (!posixRel) {
		return [];
	}
	return [`**/${posixRel}/**`, `${posixRel}/**`];
}
