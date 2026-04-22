import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const dontDestroyNotesSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("set"),
			Type.Literal("clear"),
			Type.Literal("clear_all"),
			Type.Literal("list"),
			Type.Literal("history"),
		],
		{ description: "Notes action" },
	),
	slot: Type.Optional(Type.Number({ description: "Note slot 1..7 (required for set/clear)" })),
	text: Type.Optional(Type.String({ description: "Note text (required for set)" })),
});

export type DontDestroyNotesToolInput = Static<typeof dontDestroyNotesSchema>;

function formatResultText(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result as any, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 60;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((l) => theme.fg("toolOutput", l)).join("\n")}`;
	if (remaining > 0) text += theme.fg("muted", `\n... (${remaining} more lines)`);
	return text;
}

export function createDontDestroyNotesToolDefinition(): ToolDefinition<typeof dontDestroyNotesSchema, undefined> {
	return {
		name: "dont_destroy_notes",
		label: "dont_destroy_notes",
		description:
			"Manage up to 7 durable note slots included in the system prompt (never lost during compaction). Supports set/clear/clear_all/list/history.",
		promptSnippet: "Manage durable notes across compaction",
		parameters: dontDestroyNotesSchema,
		async execute(_toolCallId, args: DontDestroyNotesToolInput, _signal, _onUpdate, ctx) {
			if (!ctx) {
				throw new Error("dont_destroy_notes requires extension context");
			}

			const action = args.action;

			if (action === "set") {
				if (!args.slot) throw new Error('"slot" is required for action "set"');
				if (typeof args.text !== "string") throw new Error('"text" is required for action "set"');
				const r = ctx.dontDestroyNotes.set(args.slot, args.text);
				return {
					content: [
						{
							type: "text",
							text: r.truncated
								? `Note slot ${args.slot} set (truncated to ${r.limit} chars).`
								: `Note slot ${args.slot} set.`,
						},
					],
				};
			}

			if (action === "clear") {
				if (!args.slot) throw new Error('"slot" is required for action "clear"');
				ctx.dontDestroyNotes.clear(args.slot);
				return { content: [{ type: "text", text: `Note slot ${args.slot} cleared.` }] };
			}

			if (action === "clear_all") {
				ctx.dontDestroyNotes.clearAll();
				return { content: [{ type: "text", text: "All note slots cleared." }] };
			}

			if (action === "list") {
				const notes = ctx.dontDestroyNotes.list();
				const lines = notes.map((n) => `[${n.slot}] (max ${n.limit}) ${n.text ?? "(empty)"}`);
				return { content: [{ type: "text", text: lines.join("\n") }] };
			}

			const history = ctx.dontDestroyNotes.history();
			const lines =
				history.length === 0
					? ["(no history)"]
					: history.map((e) => {
							const t = e.timestamp.slice(11, 16);
							const slot = e.slot ? ` slot ${e.slot}` : "";
							return `${t} - note${slot} ${e.action}`;
						});
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
		renderResult(result, options, theme, showImages) {
			return new Text(formatResultText(result as any, options, theme, showImages));
		},
	};
}

export function createDontDestroyNotesTool(): AgentTool<typeof dontDestroyNotesSchema> {
	return wrapToolDefinition(createDontDestroyNotesToolDefinition());
}

