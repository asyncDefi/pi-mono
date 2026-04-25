/**
 * Normalize `tools` from a provider request body after extension hooks such as
 * `before_provider_request`.
 */

export type OutboundToolSummary = {
	name: string;
	description?: string;
	parameters?: unknown;
};

export function extractOutboundToolSummaries(payload: unknown): OutboundToolSummary[] {
	if (!payload || typeof payload !== "object") return [];
	const tools = (payload as Record<string, unknown>).tools;
	if (!Array.isArray(tools)) return [];

	const out: OutboundToolSummary[] = [];
	for (const entry of tools) {
		if (!entry || typeof entry !== "object") continue;
		const t = entry as Record<string, unknown>;

		// OpenAI-style: { type: "function", function: { name, description, parameters } }
		if (t.type === "function" && t.function && typeof t.function === "object") {
			const fn = t.function as Record<string, unknown>;
			const name = typeof fn.name === "string" ? fn.name : undefined;
			if (!name) continue;
			out.push({
				name,
				description: typeof fn.description === "string" ? fn.description : undefined,
				parameters: fn.parameters,
			});
			continue;
		}

		// Anthropic-style: { name, description, input_schema }
		if (typeof t.name === "string") {
			out.push({
				name: t.name,
				description: typeof t.description === "string" ? t.description : undefined,
				parameters: t.input_schema ?? t.inputSchema,
			});
		}
	}

	return out;
}
