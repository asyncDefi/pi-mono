import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { runLlmFunction } from "../llm-functions.js";
import { getTextOutput } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const llmFunctionSchema = Type.Object({
	name: Type.String({
		description: 'Name of the project-local llm-function under .pi/llm-functions/<name>, e.g. "review-code"',
	}),
	task: Type.String({
		description: "Concrete task for the llm-function. Include the files, diff, question, or review scope it needs.",
	}),
});

export type LlmFunctionToolInput = Static<typeof llmFunctionSchema>;

export interface LlmFunctionToolDetails {
	name: string;
	model?: string;
	tools?: string[];
	mcpServers?: string[];
	running?: boolean;
}

function formatResultText(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 40;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) {
		text += theme.fg("muted", `\n... (${remaining} more lines)`);
	}
	return text;
}

export function createLlmFunctionToolDefinition(): ToolDefinition<typeof llmFunctionSchema, LlmFunctionToolDetails> {
	return {
		name: "llm_function",
		label: "llm_function",
		description:
			"Run one configured project-local llm-function from .pi/llm-functions/<name> and wait for its response before continuing.",
		promptSnippet: "Run a project-local llm-function such as review-code; only one llm-function can run at a time",
		promptGuidelines: [
			"Use llm_function for configured project-local LLM functions such as review-code, then wait for and incorporate its result before continuing",
			"Do not call more than one llm_function concurrently; llm_function calls are serialized and blocking",
		],
		parameters: llmFunctionSchema,
		executionMode: "sequential",
		async execute(_toolCallId, args: LlmFunctionToolInput, signal, onUpdate, ctx) {
			if (!ctx) {
				throw new Error("llm_function requires extension context");
			}

			const name = args.name.trim();
			const task = args.task.trim();
			if (!name) {
				throw new Error('"name" is required');
			}
			if (!task) {
				throw new Error('"task" is required');
			}

			const modelRegistry = ctx.modelRegistry;
			const cwd = ctx.cwd;
			const result = await runLlmFunction({
				cwd,
				name,
				task,
				modelRegistry,
				signal,
				onUpdate: (text) => {
					onUpdate?.({
						content: [{ type: "text", text }],
						details: { name, running: true },
					});
				},
			});

			return {
				content: [{ type: "text", text: result.output }],
				details: {
					name: result.name,
					model: result.model,
					tools: result.tools,
					mcpServers: result.mcpServers,
				},
			};
		},
		renderCall(args, theme, _context) {
			const name = args.name || "...";
			const task = args.task ? (args.task.length > 72 ? `${args.task.slice(0, 72)}...` : args.task) : "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("llm_function "))}${theme.fg("accent", name)}\n  ${theme.fg("dim", task)}`,
				0,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResultText(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createLlmFunctionTool(): AgentTool<typeof llmFunctionSchema> {
	return wrapToolDefinition(createLlmFunctionToolDefinition());
}
