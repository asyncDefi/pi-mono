import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const skillsContextSchema = Type.Object({
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
				"Skill context action: load, unload, list_active (in LLM context), list_discovered or list (all discovered names/descriptions), history",
		},
	),
	name: Type.Optional(
		Type.String({
			description:
				'Skill name for load/unload (same as the name="..." attribute on each <SKILL_*> block inside <LOADED_SKILLS> in the system prompt)',
		}),
	),
});

export type SkillsContextToolInput = Static<typeof skillsContextSchema>;

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
	let text = `${displayLines.map((l) => theme.fg("toolOutput", l)).join("\n")}`;
	if (remaining > 0) {
		text += theme.fg("muted", `\n... (${remaining} more lines)`);
	}
	return text;
}

export function createSkillsContextToolDefinition(): ToolDefinition<typeof skillsContextSchema, undefined> {
	return {
		name: "skills_context",
		label: "skills_context",
		description:
			"Load/unload discovered skills into the current LLM context; list_discovered (or list) for all discovered skill names and descriptions; list_active for skills currently in context; history for recent load/unload events.",
		promptSnippet: "Load/unload skills into context",
		parameters: skillsContextSchema,
		async execute(_toolCallId, args: SkillsContextToolInput, _signal, _onUpdate, ctx) {
			if (!ctx) {
				throw new Error("skills_context requires extension context");
			}

			const action = args.action;
			const name = args.name?.trim();

			if ((action === "load" || action === "unload") && (!name || name.length === 0)) {
				throw new Error(`"name" is required for action "${action}"`);
			}

			if (action === "load") {
				const r = ctx.skillsContext.load(name!);
				return {
					content: [
						{
							type: "text",
							text: r.alreadyLoaded ? `Skill "${name}" already loaded.` : `Skill "${name}" loaded into context.`,
						},
					],
					details: undefined,
				};
			}

			if (action === "unload") {
				const r = ctx.skillsContext.unload(name!);
				return {
					content: [
						{
							type: "text",
							text: !r.wasLoaded ? `Skill "${name}" was not loaded.` : `Skill "${name}" unloaded from context.`,
						},
					],
					details: undefined,
				};
			}

			if (action === "list_active") {
				const active = ctx.skillsContext.listActive();
				return {
					content: [
						{
							type: "text",
							text: active.length === 0 ? "(no active skills)" : active.join("\n"),
						},
					],
					details: undefined,
				};
			}

			if (action === "list_discovered" || action === "list") {
				const lines = ctx.skillsContext.listDiscovered();
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: undefined,
				};
			}

			const history = ctx.skillsContext.history();
			const lines =
				history.length === 0
					? ["(no history)"]
					: history.map((e) => `${e.timestamp.slice(11, 16)} - skill ${e.name} ${e.action}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResultText(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createSkillsContextTool(): AgentTool<typeof skillsContextSchema> {
	return wrapToolDefinition(createSkillsContextToolDefinition());
}
