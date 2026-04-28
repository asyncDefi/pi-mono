import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import {
	createWebSearchToolDefinition,
	isDomainAllowed,
	parseAllowedDomainsConfig,
	type WebSearchOperations,
} from "../src/core/tools/web-search.js";

function response(body: string, init: ResponseInit & { url?: string } = {}): Response {
	const result = new Response(body, init);
	Object.defineProperty(result, "url", { value: init.url ?? "https://example.com/page" });
	return result;
}

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

describe("web_search allowed domains", () => {
	it("allows exact domains", () => {
		const allowed = parseAllowedDomainsConfig(`["example.com"]`);
		expect(isDomainAllowed("example.com", allowed)).toBe(true);
	});

	it("allows wildcard subdomains", () => {
		const allowed = parseAllowedDomainsConfig(`["*.example.org"]`);
		expect(isDomainAllowed("docs.example.org", allowed)).toBe(true);
		expect(isDomainAllowed("api.docs.example.org", allowed)).toBe(true);
	});

	it("rejects unrelated domains", () => {
		const allowed = parseAllowedDomainsConfig(`["example.com", "*.example.org"]`);
		expect(isDomainAllowed("not-example.com", allowed)).toBe(false);
	});

	it("does not allow the parent domain for a wildcard entry", () => {
		const allowed = parseAllowedDomainsConfig(`["*.example.org"]`);
		expect(isDomainAllowed("example.org", allowed)).toBe(false);
	});
});

describe("web_search tool", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-web-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function createTool(operations: WebSearchOperations) {
		return createWebSearchToolDefinition(cwd, { operations });
	}

	function executeTool(
		tool: ReturnType<typeof createTool>,
		toolCallId: string,
		input: Parameters<typeof tool.execute>[1],
	) {
		return tool.execute(toolCallId, input, undefined, undefined, {} as ExtensionContext);
	}

	it("rejects missing allowed domain config", async () => {
		const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
		const tool = createTool({
			readAllowedDomainsConfig: () => {
				throw missing;
			},
			fetch: async () => response(""),
		});

		await expect(executeTool(tool, "call-1", { url: "https://example.com/page" })).rejects.toThrow(
			/allowedDomains\.json does not exist/,
		);
	});

	it("rejects disallowed URLs before fetching", async () => {
		let fetched = false;
		const tool = createTool({
			readAllowedDomainsConfig: () => `["example.com"]`,
			fetch: async () => {
				fetched = true;
				return response("");
			},
		});

		await expect(executeTool(tool, "call-2", { url: "https://evil.test/page" })).rejects.toThrow(
			/Domain not allowed/,
		);
		expect(fetched).toBe(false);
	});

	it("rejects redirects to disallowed domains", async () => {
		const tool = createTool({
			readAllowedDomainsConfig: () => `["example.com"]`,
			fetch: async () =>
				response("redirected", {
					headers: { "content-type": "text/plain" },
					url: "https://evil.test/page",
				}),
		});

		await expect(executeTool(tool, "call-3", { url: "https://example.com/page" })).rejects.toThrow(
			/Redirected domain not allowed/,
		);
	});

	it("returns query excerpts from fetched HTML", async () => {
		const tool = createTool({
			readAllowedDomainsConfig: () => `["example.com"]`,
			fetch: async () =>
				response("<html><body><h1>Docs</h1><p>Alpha beta gamma target delta epsilon.</p></body></html>", {
					headers: { "content-type": "text/html; charset=utf-8" },
					url: "https://example.com/page",
				}),
		});

		const result = await executeTool(tool, "call-4", { url: "https://example.com/page", query: "target" });
		const output = getTextOutput(result);
		expect(output).toContain("1. Docs Alpha beta gamma target delta epsilon.");
		expect(output).not.toContain("<p>");
	});

	it("truncates long query output", async () => {
		const page = Array.from(
			{ length: 220 },
			(_, index) => `section ${index} ${"x".repeat(240)} needle ${"y".repeat(240)}`,
		).join(" ");
		const tool = createTool({
			readAllowedDomainsConfig: () => `["example.com"]`,
			fetch: async () =>
				response(page, {
					headers: { "content-type": "text/plain" },
					url: "https://example.com/page",
				}),
		});

		const result = await executeTool(tool, "call-5", {
			url: "https://example.com/page",
			query: "needle",
			limit: 220,
		});
		const output = getTextOutput(result);
		expect(output).toContain("limit reached");
		expect(result.details?.truncation?.truncated).toBe(true);
	});
});
