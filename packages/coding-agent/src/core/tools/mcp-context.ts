import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const mcpContextSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("load"),
			Type.Literal("unload"),
			Type.Literal("list_active"),
			Type.Literal("list_discovered"),
			Type.Literal("list"),
			Type.Literal("history"),
		],
		{
			description:
				"MCP context action: load, unload, list_active (active MCP servers/tools), list_discovered or list (all configured MCP servers), history",
		},
	),
	name: Type.Optional(Type.String({ description: "MCP server name for load/unload from .pi/mcp.json" })),
});

export type McpContextToolInput = Static<typeof mcpContextSchema>;

function formatResultText(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 40;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += theme.fg("muted", `\n... (${remaining} more lines)`);
	}
	return text;
}

export function createMcpContextToolDefinition(): ToolDefinition<typeof mcpContextSchema, undefined> {
	return {
		name: "mcp_context",
		label: "mcp_context",
		description:
			"Load/unload MCP servers configured in .pi/mcp.json; list_discovered (or list) for configured servers; list_active for MCP servers/tools currently in context; history for recent load/unload events.",
		promptSnippet: "Load/unload MCP servers from .pi/mcp.json",
		parameters: mcpContextSchema,
		async execute(_toolCallId, args: McpContextToolInput, _signal, _onUpdate, ctx) {
			if (!ctx) {
				throw new Error("mcp_context requires extension context");
			}

			const action = args.action;
			const name = args.name?.trim();

			if ((action === "load" || action === "unload") && (!name || name.length === 0)) {
				throw new Error(`"name" is required for action "${action}"`);
			}

			if (action === "load") {
				const result = await ctx.mcpContext.load(name!);
				const toolText = result.toolNames.length > 0 ? ` Tools: ${result.toolNames.join(", ")}` : "";
				return {
					content: [
						{
							type: "text",
							text: result.alreadyLoaded
								? `MCP server "${name}" already loaded.${toolText}`
								: `MCP server "${name}" loaded into context.${toolText}`,
						},
					],
					details: undefined,
				};
			}

			if (action === "unload") {
				const result = await ctx.mcpContext.unload(name!);
				return {
					content: [
						{
							type: "text",
							text: !result.wasLoaded
								? `MCP server "${name}" was not loaded.`
								: `MCP server "${name}" unloaded from context.`,
						},
					],
					details: undefined,
				};
			}

			if (action === "list_active") {
				const active = ctx.mcpContext.listActive();
				return {
					content: [{ type: "text", text: active.length === 0 ? "(no active MCP servers)" : active.join("\n") }],
					details: undefined,
				};
			}

			if (action === "list_discovered" || action === "list") {
				const lines = ctx.mcpContext.listDiscovered();
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: undefined,
				};
			}

			const history = ctx.mcpContext.history();
			const lines =
				history.length === 0
					? ["(no history)"]
					: history.map((event) => `${event.timestamp.slice(11, 16)} - MCP ${event.name} ${event.action}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResultText(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createMcpContextTool(): AgentTool<typeof mcpContextSchema> {
	return wrapToolDefinition(createMcpContextToolDefinition());
}
