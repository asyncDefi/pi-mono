import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiProvider } from "../src/api-registry.js";
import { getEnvApiKey } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";
import { streamOllamaChat } from "../src/providers/ollama-chat.js";
import type { Context } from "../src/types.js";
import "../src/providers/register-builtins.js";

const originalFetch = global.fetch;
const originalOllamaApiKey = process.env.OLLAMA_API_KEY;

afterEach(() => {
	global.fetch = originalFetch;
	if (originalOllamaApiKey === undefined) {
		delete process.env.OLLAMA_API_KEY;
	} else {
		process.env.OLLAMA_API_KEY = originalOllamaApiKey;
	}
	vi.restoreAllMocks();
});

function streamFromLines(lines: unknown[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
			}
			controller.close();
		},
	});
}

describe("ollama cloud provider", () => {
	it("reads OLLAMA_API_KEY for ollama-cloud", () => {
		process.env.OLLAMA_API_KEY = "ollama-test-key";

		expect(getEnvApiKey("ollama-cloud")).toBe("ollama-test-key");
	});

	it("registers ollama-chat and exposes ollama-cloud models", () => {
		const provider = getApiProvider("ollama-chat");
		const model = getModel("ollama-cloud", "gpt-oss:120b");
		const cloudModel = getModel("ollama-cloud", "deepseek-v4-flash");

		expect(provider).toBeDefined();
		expect(model).toBeDefined();
		expect(model.provider).toBe("ollama-cloud");
		expect(model.api).toBe("ollama-chat");
		expect(model.baseUrl).toBe("https://ollama.com/api");
		expect(cloudModel).toBeDefined();
		expect(cloudModel.contextWindow).toBe(1048576);
	});

	it("streams Ollama Cloud chat responses", async () => {
		const model = getModel("ollama-cloud", "gpt-oss:120b");
		const context: Context = {
			systemPrompt: "Be concise.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		global.fetch = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://ollama.com/api/chat");
			expect(init?.method).toBe("POST");
			const headers = init?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer test-key");

			const body = JSON.parse(String(init?.body));
			expect(body.model).toBe("gpt-oss:120b");
			expect(body.messages).toEqual([
				{ role: "system", content: "Be concise." },
				{ role: "user", content: "Say hello" },
			]);

			return new Response(
				streamFromLines([
					{ model: "gpt-oss:120b", message: { role: "assistant", content: "Hel" }, done: false },
					{
						model: "gpt-oss:120b",
						message: { role: "assistant", content: "lo" },
						done: true,
						done_reason: "stop",
						prompt_eval_count: 4,
						eval_count: 2,
					},
				]),
				{ status: 200 },
			);
		});

		const response = streamOllamaChat(model, context, { apiKey: "test-key" });
		const events = [];
		for await (const event of response) {
			events.push(event.type);
		}
		const message = await response.result();

		expect(events).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(message.usage.input).toBe(4);
		expect(message.usage.output).toBe(2);
		expect(message.usage.totalTokens).toBe(6);
	});
});
