export {
	type ArchitectureContextToolInput,
	createArchitectureContextTool,
	createArchitectureContextToolDefinition,
} from "./architecture-context.js";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createDontDestroyNotesTool,
	createDontDestroyNotesToolDefinition,
	type DontDestroyNotesToolInput,
} from "./dont-destroy-notes.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.js";
export {
	createLlmFunctionTool,
	createLlmFunctionToolDefinition,
	type LlmFunctionToolDetails,
	type LlmFunctionToolInput,
} from "./llm-function.js";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.js";
export {
	createMcpContextTool,
	createMcpContextToolDefinition,
	type McpContextToolInput,
} from "./mcp-context.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.js";
export {
	createSkillsContextTool,
	createSkillsContextToolDefinition,
	type SkillsContextToolInput,
} from "./skills-context.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWebSearchTool,
	createWebSearchToolDefinition,
	isDomainAllowed,
	parseAllowedDomainsConfig,
	type WebSearchOperations,
	type WebSearchToolDetails,
	type WebSearchToolInput,
} from "./web-search.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { createArchitectureContextTool, createArchitectureContextToolDefinition } from "./architecture-context.js";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.js";
import { createDontDestroyNotesTool, createDontDestroyNotesToolDefinition } from "./dont-destroy-notes.js";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.js";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.js";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.js";
import { createLlmFunctionTool, createLlmFunctionToolDefinition } from "./llm-function.js";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.js";
import { createMcpContextTool, createMcpContextToolDefinition } from "./mcp-context.js";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.js";
import { createSkillsContextTool, createSkillsContextToolDefinition } from "./skills-context.js";
import { createWebSearchTool, createWebSearchToolDefinition } from "./web-search.js";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "skills_context"
	| "mcp_context"
	| "architecture_context"
	| "llm_function"
	| "dont_destroy_notes"
	| "web_search";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"skills_context",
	"mcp_context",
	"architecture_context",
	"llm_function",
	"dont_destroy_notes",
	"web_search",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "skills_context":
			return createSkillsContextToolDefinition();
		case "mcp_context":
			return createMcpContextToolDefinition();
		case "architecture_context":
			return createArchitectureContextToolDefinition();
		case "llm_function":
			return createLlmFunctionToolDefinition();
		case "dont_destroy_notes":
			return createDontDestroyNotesToolDefinition();
		case "web_search":
			return createWebSearchToolDefinition(cwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "skills_context":
			return createSkillsContextTool();
		case "mcp_context":
			return createMcpContextTool();
		case "architecture_context":
			return createArchitectureContextTool();
		case "llm_function":
			return createLlmFunctionTool();
		case "dont_destroy_notes":
			return createDontDestroyNotesTool();
		case "web_search":
			return createWebSearchTool(cwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		skills_context: createSkillsContextToolDefinition(),
		mcp_context: createMcpContextToolDefinition(),
		architecture_context: createArchitectureContextToolDefinition(),
		llm_function: createLlmFunctionToolDefinition(),
		dont_destroy_notes: createDontDestroyNotesToolDefinition(),
		web_search: createWebSearchToolDefinition(cwd),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		skills_context: createSkillsContextTool(),
		mcp_context: createMcpContextTool(),
		architecture_context: createArchitectureContextTool(),
		llm_function: createLlmFunctionTool(),
		dont_destroy_notes: createDontDestroyNotesTool(),
		web_search: createWebSearchTool(cwd),
	};
}
