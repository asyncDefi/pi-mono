import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import {
	type ArchitectureContainer,
	type ArchitectureRelation,
	type ArchitectureScript,
	type ArchitectureStatus,
	architectureRelationSchema,
	architectureScriptSchema,
} from "../architecture.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const architectureContextSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("init"),
				Type.Literal("status"),
				Type.Literal("validate"),
				Type.Literal("list_systems"),
				Type.Literal("get"),
				Type.Literal("load"),
				Type.Literal("unload"),
				Type.Literal("list_active"),
				Type.Literal("history"),
				Type.Literal("upsert_system"),
				Type.Literal("upsert_subsystem"),
				Type.Literal("upsert_script"),
				Type.Literal("upsert_relation"),
				Type.Literal("remove"),
			],
			{
				description:
					"Architecture context action: init, status, validate, list_systems, get, load, unload, list_active, history, upsert_system, upsert_subsystem, upsert_script, upsert_relation, remove",
			},
		),
		id: Type.Optional(Type.String({ description: "Architecture item id for get/load/unload/remove" })),
		parentId: Type.Optional(Type.String({ description: "Parent system/subsystem id for upsert_subsystem" })),
		containerId: Type.Optional(Type.String({ description: "System/subsystem id for upsert_script" })),
		system: Type.Optional(createArchitectureContainerPatchSchema("Top-level global system payload")),
		subsystem: Type.Optional(createArchitectureContainerPatchSchema("Subsystem payload")),
		script: Type.Optional(architectureScriptSchema),
		relation: Type.Optional(architectureRelationSchema),
	},
	{ additionalProperties: false },
);

export type ArchitectureContextToolInput = Static<typeof architectureContextSchema>;

type TextResult = {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
};

function createArchitectureContainerPatchSchema(description: string) {
	return Type.Object(
		{
			id: Type.String({ minLength: 1 }),
			name: Type.String({ minLength: 1 }),
			responsibility: Type.String({ minLength: 1 }),
			boundaries: Type.Optional(Type.Array(Type.String())),
			publicSurface: Type.Optional(Type.Array(Type.String())),
			scripts: Type.Optional(Type.Array(architectureScriptSchema)),
			notes: Type.Optional(Type.Array(Type.String())),
		},
		{
			additionalProperties: false,
			description: `${description}. Add nested subsystems with separate upsert_subsystem calls instead of embedding recursive subsystems here.`,
		},
	);
}

function result(text: string): TextResult {
	return { content: [{ type: "text", text }], details: undefined };
}

function requireString(value: string | undefined, name: string, action: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(`"${name}" is required for action "${action}"`);
	}
	return trimmed;
}

function requireObject<T>(value: T | undefined, name: string, action: string): T {
	if (!value) {
		throw new Error(`"${name}" is required for action "${action}"`);
	}
	return value;
}

function statusText(status: ArchitectureStatus): string {
	if (!status.exists) {
		return `${status.path}\nmissing`;
	}
	if (!status.valid) {
		return `${status.path}\ninvalid\n${status.errors.join("\n")}`;
	}
	return `${status.path}\nvalid\nsystems: ${status.systemCount}\nrelations: ${status.relationCount}`;
}

function formatResultText(
	toolResult: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(toolResult, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 60;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) {
		text += theme.fg("muted", `\n... (${remaining} more lines)`);
	}
	return text;
}

export function createArchitectureContextToolDefinition(): ToolDefinition<typeof architectureContextSchema, undefined> {
	return {
		name: "architecture_context",
		label: "architecture_context",
		description:
			"Manage the root architecture.json graph through structured actions. Use this instead of reading or editing architecture.json directly. Supports loading selected systems/subsystems/scripts into the LLM context.",
		promptSnippet: "Manage and load architecture.json graph context",
		promptGuidelines: [
			"Use architecture_context load before changing a non-trivial system when architecture.json has relevant entries.",
			"Use architecture_context patch actions after changing logical interactions, responsibilities, public surfaces, or file ownership.",
			"Do not read or edit architecture.json directly; use architecture_context for all architecture access.",
			"Keep architecture segmented as Global Systems -> Subsystems -> Scripts with explicit dependencies and boundaries.",
		],
		parameters: architectureContextSchema,
		async execute(_toolCallId, args: ArchitectureContextToolInput, _signal, _onUpdate, ctx) {
			if (!ctx) {
				throw new Error("architecture_context requires extension context");
			}

			const action = args.action;
			if (action === "init") {
				const init = await ctx.architectureContext.init();
				return result(init.created ? `Created ${init.path}` : `${init.path} already exists`);
			}
			if (action === "status") {
				return result(statusText(await ctx.architectureContext.status()));
			}
			if (action === "validate") {
				const validation = await ctx.architectureContext.validate();
				return result(validation.valid ? "architecture.json is valid" : validation.errors.join("\n"));
			}
			if (action === "list_systems") {
				const lines = await ctx.architectureContext.listSystems();
				return result(lines.join("\n"));
			}
			if (action === "get") {
				const id = requireString(args.id, "id", action);
				return result(await ctx.architectureContext.get(id));
			}
			if (action === "load") {
				const id = requireString(args.id, "id", action);
				const loaded = await ctx.architectureContext.load(id);
				return result(
					loaded.alreadyLoaded
						? `Architecture context "${id}" already loaded.`
						: `Architecture context "${id}" loaded.`,
				);
			}
			if (action === "unload") {
				const id = requireString(args.id, "id", action);
				const unloaded = await ctx.architectureContext.unload(id);
				return result(
					unloaded.wasLoaded
						? `Architecture context "${id}" unloaded.`
						: `Architecture context "${id}" was not loaded.`,
				);
			}
			if (action === "list_active") {
				const active = ctx.architectureContext.listActive();
				return result(active.length === 0 ? "(no active architecture contexts)" : active.join("\n"));
			}
			if (action === "history") {
				const history = ctx.architectureContext.history();
				const lines =
					history.length === 0
						? ["(no history)"]
						: history.map(
								(event) => `${event.timestamp.slice(11, 16)} - architecture ${event.id} ${event.action}`,
							);
				return result(lines.join("\n"));
			}
			if (action === "upsert_system") {
				const system = requireObject(args.system as ArchitectureContainer | undefined, "system", action);
				await ctx.architectureContext.upsertSystem(system);
				return result(`Architecture system "${system.id}" upserted.`);
			}
			if (action === "upsert_subsystem") {
				const parentId = requireString(args.parentId, "parentId", action);
				const subsystem = requireObject(args.subsystem as ArchitectureContainer | undefined, "subsystem", action);
				await ctx.architectureContext.upsertSubsystem(parentId, subsystem);
				return result(`Architecture subsystem "${subsystem.id}" upserted.`);
			}
			if (action === "upsert_script") {
				const containerId = requireString(args.containerId, "containerId", action);
				const script = requireObject(args.script as ArchitectureScript | undefined, "script", action);
				await ctx.architectureContext.upsertScript(containerId, script);
				return result(`Architecture script "${script.id}" upserted.`);
			}
			if (action === "upsert_relation") {
				const relation = requireObject(args.relation as ArchitectureRelation | undefined, "relation", action);
				await ctx.architectureContext.upsertRelation(relation);
				return result(`Architecture relation "${relation.id}" upserted.`);
			}

			const id = requireString(args.id, "id", action);
			const removed = await ctx.architectureContext.remove(id);
			return result(
				removed.removed ? `Architecture item "${id}" removed.` : `Architecture item "${id}" was not found.`,
			);
		},
		renderResult(toolResult, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResultText(toolResult, options, theme, context.showImages));
			return text;
		},
	};
}

export function createArchitectureContextTool(): AgentTool<typeof architectureContextSchema> {
	return wrapToolDefinition(createArchitectureContextToolDefinition());
}
