/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Persisted notes that must not be lost to compaction (7 slots). */
	dontDestroyNotes?: Array<string | null>;
}

const DONT_DESTROY_SLOT_LIMITS = [700, 400, 250, 200, 170, 150, 130] as const; // sum=2000

function formatDontDestroySection(notes: Array<string | null> | undefined): string {
	const slots = notes && notes.length === 7 ? notes : new Array<string | null>(7).fill(null);
	const lines: string[] = [
		"|<DONT-DESTROY>|",
		"These notes must NEVER be removed or summarized away (even during compaction).",
		"Maintain at most 7 slots. Slot 1 has the largest character budget; slot 7 the smallest.",
		"",
	];
	for (let i = 0; i < 7; i++) {
		const limit = DONT_DESTROY_SLOT_LIMITS[i];
		const text = slots[i] ?? "(empty)";
		lines.push(`[${i + 1}] (max ${limit} chars) ${text}`);
	}
	return lines.join("\n");
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		dontDestroyNotes,
	} = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";
	const toolsSection = `Available tools:\n${toolsList}`;
	const dontDestroySection = formatDontDestroySection(dontDestroyNotes);

	if (customPrompt) {
		let soul = customPrompt;

		if (appendSection) {
			soul += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			soul += "\n\n# Project Context\n\n";
			soul += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				soul += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append loaded skills (skills_context); not gated on read — load is the mechanism
		if (skills.length > 0) {
			soul += formatSkillsForPrompt(skills, { embedBodies: true });
		}

		// Add date and working directory last
		soul += `\nCurrent date: ${date}`;
		soul += `\nCurrent working directory: ${promptCwd}`;

		return `|<SOUL>|\n${soul}\n\n|<Tools>|\n${toolsSection}\n\n${dontDestroySection}`;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");
	addGuideline(
		"Load/unload skills with skills_context (actions load, unload, list_active, list_discovered or list, history); use list_discovered or list to answer which skills exist without reading project config files",
	);
	addGuideline("Use dont_destroy_notes to maintain short durable notes across compaction (7 slots, 2000 chars total)");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let soul = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		soul += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		soul += "\n\n# Project Context\n\n";
		soul += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			soul += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append loaded skills (skills_context); not gated on read — load is the mechanism
	if (skills.length > 0) {
		soul += formatSkillsForPrompt(skills, { embedBodies: true });
	}

	// Add date and working directory last
	soul += `\nCurrent date: ${date}`;
	soul += `\nCurrent working directory: ${promptCwd}`;

	return `|<SOUL>|\n${soul}\n\n|<Tools>|\n${toolsSection}\n\n${dontDestroySection}`;
}
