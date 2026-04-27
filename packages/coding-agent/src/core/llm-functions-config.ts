import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { CONFIG_DIR_NAME } from "../config.js";
import { loadMcpServersFromConfigPath, type McpServer } from "./mcp.js";
import { createSyntheticSourceInfo } from "./source-info.js";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const LLM_FUNCTION_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const LLM_FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type LlmFunctionReadOnlyToolName = (typeof LLM_FUNCTION_READ_ONLY_TOOLS)[number];

export interface LlmFunctionModelConfig {
	provider: string;
	model: string;
	thinking?: ThinkingLevel;
}

export interface LlmFunctionConfig {
	name: string;
	dir: string;
	instructionPath: string;
	instruction: string;
	modelPath: string;
	modelConfig: LlmFunctionModelConfig;
	mcpPath?: string;
	mcpServers: McpServer[];
}

export interface LlmFunctionDiagnostic {
	type: "warning" | "error";
	message: string;
	path: string;
}

export interface DiscoverLlmFunctionsResult {
	functions: LlmFunctionConfig[];
	diagnostics: LlmFunctionDiagnostic[];
}

export function getLlmFunctionsDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "llm-functions");
}

function isRealDirectory(path: string): boolean {
	try {
		const stats = lstatSync(path);
		return stats.isDirectory() && !stats.isSymbolicLink();
	} catch {
		return false;
	}
}

function validateLlmFunctionName(name: string): void {
	if (!LLM_FUNCTION_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid llm-function name: ${name}`);
	}
}

function parseModelConfig(modelPath: string): LlmFunctionModelConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(modelPath, "utf-8"));
	} catch (error) {
		throw new Error(`Failed to parse model.json: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("model.json must be a JSON object");
	}

	const raw = parsed as Record<string, unknown>;
	if (typeof raw.provider !== "string" || raw.provider.trim() === "") {
		throw new Error('model.json must define a non-empty string field "provider"');
	}
	if (typeof raw.model !== "string" || raw.model.trim() === "") {
		throw new Error('model.json must define a non-empty string field "model"');
	}
	if (
		raw.thinking !== undefined &&
		(typeof raw.thinking !== "string" || !THINKING_LEVELS.has(raw.thinking as ThinkingLevel))
	) {
		throw new Error(`model.json field "thinking" must be one of: ${Array.from(THINKING_LEVELS).join(", ")}`);
	}

	return {
		provider: raw.provider.trim(),
		model: raw.model.trim(),
		thinking: raw.thinking as ThinkingLevel | undefined,
	};
}

export function loadLlmFunction(cwd: string, name: string): LlmFunctionConfig {
	const normalizedName = name.trim();
	if (!normalizedName) {
		throw new Error("llm-function name is required");
	}
	validateLlmFunctionName(normalizedName);

	const functionsDir = getLlmFunctionsDir(cwd);
	const functionDir = resolve(functionsDir, normalizedName);
	const normalizedRoot = resolve(functionsDir);
	if (functionDir !== normalizedRoot && !functionDir.startsWith(`${normalizedRoot}${sep}`)) {
		throw new Error(`Invalid llm-function name: ${name}`);
	}
	if (!isRealDirectory(functionDir)) {
		throw new Error(`Unknown llm-function "${normalizedName}"`);
	}

	const instructionPath = join(functionDir, "INSTRUCTION.md");
	if (!existsSync(instructionPath)) {
		throw new Error(`Missing INSTRUCTION.md for llm-function "${normalizedName}"`);
	}
	const instruction = readFileSync(instructionPath, "utf-8").trim();
	if (!instruction) {
		throw new Error(`INSTRUCTION.md for llm-function "${normalizedName}" is empty`);
	}

	const modelPath = join(functionDir, "model.json");
	if (!existsSync(modelPath)) {
		throw new Error(`Missing model.json for llm-function "${normalizedName}"`);
	}
	const modelConfig = parseModelConfig(modelPath);

	const mcpPath = join(functionDir, "mcp.json");
	const mcpResult = existsSync(mcpPath)
		? loadMcpServersFromConfigPath({
				configPath: mcpPath,
				sourceInfo: createSyntheticSourceInfo(mcpPath, {
					source: "local",
					scope: "project",
					baseDir: dirname(mcpPath),
				}),
			})
		: undefined;
	if (mcpResult && mcpResult.diagnostics.length > 0) {
		throw new Error(
			`Invalid mcp.json for llm-function "${normalizedName}": ${mcpResult.diagnostics
				.map((diagnostic) => diagnostic.message)
				.join("; ")}`,
		);
	}
	const mcpServers = mcpResult?.servers ?? [];

	return {
		name: normalizedName,
		dir: functionDir,
		instructionPath,
		instruction,
		modelPath,
		modelConfig,
		mcpPath: existsSync(mcpPath) ? mcpPath : undefined,
		mcpServers,
	};
}

export function discoverLlmFunctions(cwd: string): DiscoverLlmFunctionsResult {
	const functionsDir = getLlmFunctionsDir(cwd);
	const functions: LlmFunctionConfig[] = [];
	const diagnostics: LlmFunctionDiagnostic[] = [];

	if (!isRealDirectory(functionsDir)) {
		return { functions, diagnostics };
	}

	for (const entry of readdirSync(functionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const name = entry.name;
		const dir = join(functionsDir, name);
		if (!isRealDirectory(dir)) continue;
		try {
			functions.push(loadLlmFunction(cwd, name));
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
				path: dir,
			});
		}
	}

	functions.sort((a, b) => a.name.localeCompare(b.name));
	return { functions, diagnostics };
}

export function getLlmFunctionReadOnlyToolNames(): LlmFunctionReadOnlyToolName[] {
	return [...LLM_FUNCTION_READ_ONLY_TOOLS];
}

function promptValue(value: string): string {
	return JSON.stringify(value);
}

export function formatLlmFunctionsForPrompt(result: DiscoverLlmFunctionsResult): string {
	const lines = [
		"# Available LLM Functions",
		"Use the llm_function tool with exactly one of these names. Calls are blocking and serialized.",
	];
	if (result.functions.length === 0) {
		lines.push("- (none)");
	} else {
		for (const fn of result.functions) {
			const model = `${fn.modelConfig.provider}/${fn.modelConfig.model}`;
			const thinking = fn.modelConfig.thinking ?? "default";
			const mcp = fn.mcpServers.length > 0 ? fn.mcpServers.map((server) => server.name).join(", ") : "none";
			lines.push(
				`- name=${promptValue(fn.name)} model=${promptValue(model)} thinking=${promptValue(thinking)} mcp=${promptValue(mcp)}`,
			);
		}
	}
	if (result.diagnostics.length > 0) {
		lines.push("", "Invalid llm-function directories:");
		for (const diagnostic of result.diagnostics) {
			lines.push(`- path=${promptValue(diagnostic.path)} message=${promptValue(diagnostic.message)}`);
		}
	}
	return lines.join("\n");
}
