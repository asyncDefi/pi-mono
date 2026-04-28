import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { CONFIG_DIR_NAME } from "../../config.js";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { theme as themeInstance } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const ALLOWED_DOMAINS_FILE = "allowedDomains.json";
const DEFAULT_LIMIT = 5;
const MAX_FETCH_BYTES = 1024 * 1024;

const webSearchSchema = Type.Object({
	url: Type.String({ description: "HTTP or HTTPS URL to fetch. The final URL domain must be allowed." }),
	query: Type.Optional(Type.String({ description: "Text to search for in the fetched page" })),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of excerpts to return (default: ${DEFAULT_LIMIT})` }),
	),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	finalUrl: string;
	truncation?: TruncationResult;
}

export interface WebSearchOperations {
	readAllowedDomainsConfig: (absolutePath: string) => Promise<string> | string;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const defaultWebSearchOperations: WebSearchOperations = {
	readAllowedDomainsConfig: (absolutePath) => readFileSync(absolutePath, "utf-8"),
	fetch: (url, init) => fetch(url, init),
};

export function parseAllowedDomainsConfig(json: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		throw new Error(
			`Invalid ${CONFIG_DIR_NAME}/${ALLOWED_DOMAINS_FILE}: ${error instanceof Error ? error.message : "invalid JSON"}`,
		);
	}

	if (!Array.isArray(parsed)) {
		throw new Error(`Invalid ${CONFIG_DIR_NAME}/${ALLOWED_DOMAINS_FILE}: expected an array of domain strings`);
	}

	return parsed.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim() === "") {
			throw new Error(
				`Invalid ${CONFIG_DIR_NAME}/${ALLOWED_DOMAINS_FILE}: entry ${index + 1} must be a non-empty string`,
			);
		}
		const normalized = entry.trim().toLowerCase();
		const host = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
		if (host.includes("/") || host.includes(":") || host.startsWith(".") || host.endsWith(".")) {
			throw new Error(
				`Invalid ${CONFIG_DIR_NAME}/${ALLOWED_DOMAINS_FILE}: entry ${index + 1} must be a domain or wildcard domain`,
			);
		}
		return normalized;
	});
}

export function isDomainAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
	const normalizedHost = hostname.toLowerCase();
	return allowedDomains.some((allowed) => {
		if (allowed.startsWith("*.")) {
			const suffix = allowed.slice(2);
			return normalizedHost.endsWith(`.${suffix}`) && normalizedHost !== suffix;
		}
		return normalizedHost === allowed;
	});
}

function formatWebSearchCall(
	args: { url?: string; query?: string; limit?: number } | undefined,
	theme: typeof themeInstance,
): string {
	const url = str(args?.url);
	const query = str(args?.query);
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("web_search")) +
		" " +
		(url === null ? invalidArg : theme.fg("accent", url || ""));
	if (query) text += theme.fg("toolOutput", ` for "${query}"`);
	if (args?.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
	return text;
}

function formatWebSearchResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: WebSearchToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof themeInstance,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}
	if (result.details?.truncation?.truncated) {
		text += `\n${theme.fg("warning", `[Truncated: ${formatSize(result.details.truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
	}
	return text;
}

function validateHttpUrl(rawUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("web_search only supports http and https URLs");
	}
	return parsed;
}

function stripHtmlToText(input: string): string {
	return input
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function makeExcerpts(text: string, query: string, limit: number): string[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return [text.slice(0, 2000)];

	const lowerText = text.toLowerCase();
	const excerpts: string[] = [];
	let fromIndex = 0;
	while (excerpts.length < limit) {
		const index = lowerText.indexOf(normalizedQuery, fromIndex);
		if (index === -1) break;
		const start = Math.max(0, index - 180);
		const end = Math.min(text.length, index + query.length + 180);
		const prefix = start > 0 ? "..." : "";
		const suffix = end < text.length ? "..." : "";
		excerpts.push(`${prefix}${text.slice(start, end).trim()}${suffix}`);
		fromIndex = index + normalizedQuery.length;
	}
	return excerpts;
}

async function readResponseText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) {
		return response.text();
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			total += value.byteLength;
			if (total > MAX_FETCH_BYTES) {
				throw new Error(`Fetched page exceeds ${formatSize(MAX_FETCH_BYTES)} limit`);
			}
			chunks.push(value);
		}
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export function createWebSearchToolDefinition(
	cwd: string,
	options?: { operations?: WebSearchOperations },
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	const operations = options?.operations ?? defaultWebSearchOperations;
	return {
		name: "web_search",
		label: "web_search",
		description:
			`Fetch an HTTP/HTTPS URL from domains allowed by ${CONFIG_DIR_NAME}/${ALLOWED_DOMAINS_FILE}. ` +
			"Returns compact page text or query excerpts. This is not a general web search engine.",
		promptSnippet: `Fetch allowed web pages and search their readable text. Only domains in ${CONFIG_DIR_NAME}/${ALLOWED_DOMAINS_FILE} are accessible.`,
		parameters: webSearchSchema,
		async execute(_toolCallId, { url, query, limit }: WebSearchToolInput, signal?: AbortSignal) {
			const parsedUrl = validateHttpUrl(url);
			const configPath = path.join(cwd, CONFIG_DIR_NAME, ALLOWED_DOMAINS_FILE);
			let allowedDomains: string[];
			try {
				allowedDomains = parseAllowedDomainsConfig(await operations.readAllowedDomainsConfig(configPath));
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") {
					throw new Error(`No domains are allowed: ${CONFIG_DIR_NAME}/${ALLOWED_DOMAINS_FILE} does not exist`);
				}
				throw error;
			}

			if (!isDomainAllowed(parsedUrl.hostname, allowedDomains)) {
				throw new Error(`Domain not allowed for web_search: ${parsedUrl.hostname}`);
			}

			const response = await operations.fetch(parsedUrl.toString(), {
				redirect: "follow",
				signal,
				headers: { "user-agent": "pi-web-search" },
			});
			const finalUrl = response.url || parsedUrl.toString();
			const finalParsedUrl = validateHttpUrl(finalUrl);
			if (!isDomainAllowed(finalParsedUrl.hostname, allowedDomains)) {
				throw new Error(`Redirected domain not allowed for web_search: ${finalParsedUrl.hostname}`);
			}
			if (!response.ok) {
				throw new Error(`Fetch failed for ${finalUrl}: HTTP ${response.status}`);
			}

			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
			if (
				contentType &&
				!contentType.includes("text/html") &&
				!contentType.startsWith("text/plain") &&
				!contentType.startsWith("application/xhtml+xml")
			) {
				throw new Error(`Unsupported content type for web_search: ${contentType}`);
			}

			const rawText = await readResponseText(response);
			const text = contentType.includes("html") || rawText.includes("<") ? stripHtmlToText(rawText) : rawText.trim();
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
			const excerpts = query ? makeExcerpts(text, query, effectiveLimit) : [text.slice(0, 4000)];
			const output =
				excerpts.length > 0
					? excerpts.map((excerpt, index) => `${index + 1}. ${excerpt}`).join("\n\n")
					: "No matches found";
			const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
			const resultText = truncation.truncated
				? `${truncation.content}\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached]`
				: truncation.content;

			return {
				content: [{ type: "text", text: resultText }],
				details: { finalUrl, truncation: truncation.truncated ? truncation : undefined },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebSearchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebSearchResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createWebSearchTool(
	cwd: string,
	options?: { operations?: WebSearchOperations },
): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(cwd, options));
}
