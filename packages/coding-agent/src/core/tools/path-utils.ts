import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

export function expandPath(filePath: string): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/")) {
		return os.homedir() + normalized.slice(1);
	}
	return normalized;
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	return resolvePath(cwd, expanded);
}

function realpathExistingTarget(absolutePath: string): string {
	if (existsSync(absolutePath)) {
		return realpathSync(absolutePath);
	}

	let current = absolutePath;
	const missingSegments: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) {
			return absolutePath;
		}
		missingSegments.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		current = parent;
	}

	const stat = statSync(current);
	const base = stat.isDirectory() ? realpathSync(current) : realpathSync(dirname(current));
	return resolvePath(base, ...missingSegments);
}

function isSubpathOrSame(parent: string, child: string): boolean {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function assertPathInsideCwd(absolutePath: string, cwd: string): void {
	const realCwd = realpathExistingTarget(resolvePath(cwd));
	const realTarget = realpathExistingTarget(resolvePath(absolutePath));
	if (!isSubpathOrSame(realCwd, realTarget)) {
		throw new Error(`Access outside the working directory is not allowed: ${absolutePath}`);
	}
}

const BASH_BLOCKED_OUTSIDE_CWD_MESSAGE =
	"This bash command was rejected because it appears to reference a path outside the working directory. " +
	"Shell access to external files is not allowed; use paths under the session working directory.";

const BASH_PATH_CANDIDATE_RE =
	/(?:^|[\s"'=(;|&`])((?:~(?:[/\\][^\s"'`;|&()<>]*)?)|(?:(?:[A-Za-z]:[/\\]|\/)[^\s"'`;|&()<>]*)|(?:\.\.(?:[/\\][^\s"'`;|&()<>]*)?))(?:$|[\s"'):;|&`<>])/g;

export function bashCommandReferencesPathOutsideCwd(command: string, cwd: string): boolean {
	for (const match of command.matchAll(BASH_PATH_CANDIDATE_RE)) {
		const candidate = match[1];
		if (!candidate) continue;
		try {
			assertPathInsideCwd(resolveToCwd(candidate, cwd), cwd);
		} catch {
			return true;
		}
	}
	return false;
}

export function assertBashCommandPathsInsideCwd(command: string, cwd: string): void {
	if (bashCommandReferencesPathOutsideCwd(command, cwd)) {
		throw new Error(BASH_BLOCKED_OUTSIDE_CWD_MESSAGE);
	}
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}
