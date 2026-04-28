import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost } from "../models.js";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
	UserMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { buildBaseOptions } from "./simple-options.js";

export interface OllamaChatOptions extends StreamOptions {
	tools?: Tool[];
}

interface OllamaMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	images?: string[];
	tool_calls?: OllamaToolCall[];
	tool_name?: string;
}

interface OllamaToolCall {
	function: {
		name: string;
		arguments: Record<string, unknown>;
	};
}

interface OllamaChatRequest {
	model: string;
	messages: OllamaMessage[];
	stream: true;
	tools?: OllamaToolDefinition[];
	options?: {
		temperature?: number;
		num_predict?: number;
	};
}

interface OllamaToolDefinition {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters: unknown;
	};
}

interface OllamaChatChunk {
	model?: string;
	created_at?: string;
	message?: {
		role?: string;
		content?: string;
		thinking?: string;
		tool_calls?: OllamaToolCall[];
	};
	done?: boolean;
	done_reason?: string;
	error?: string;
	prompt_eval_count?: number;
	eval_count?: number;
	total_duration?: number;
	load_duration?: number;
	prompt_eval_duration?: number;
	eval_duration?: number;
}

export const streamOllamaChat: StreamFunction<"ollama-chat", OllamaChatOptions> = (
	model: Model<"ollama-chat">,
	context: Context,
	options?: OllamaChatOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createInitialMessage(model);

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider);
			if (!apiKey) {
				throw new Error("Ollama Cloud API key is required. Set OLLAMA_API_KEY or pass apiKey.");
			}

			let payload = buildPayload(model, context, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload as OllamaChatRequest;
			}

			const response = await fetch(resolveOllamaChatUrl(model.baseUrl), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
					...model.headers,
					...options?.headers,
				},
				body: JSON.stringify(payload),
				signal: options?.signal,
			});
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			if (!response.ok) {
				throw new Error(`Ollama Cloud request failed: ${response.status} ${await response.text()}`);
			}
			if (!response.body) {
				throw new Error("Ollama Cloud response did not include a body");
			}

			stream.push({ type: "start", partial: output });
			await processOllamaStream(response.body, output, stream, model);
		} catch (error) {
			output.stopReason = isAbortError(error) ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		}
	})();

	return stream;
};

export const streamSimpleOllamaChat: StreamFunction<"ollama-chat", SimpleStreamOptions> = (
	model: Model<"ollama-chat">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	return streamOllamaChat(model, context, buildBaseOptions(model, options) satisfies OllamaChatOptions);
};

function createInitialMessage(model: Model<"ollama-chat">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function resolveOllamaChatUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/chat`;
}

function buildPayload(model: Model<"ollama-chat">, context: Context, options?: OllamaChatOptions): OllamaChatRequest {
	const messages = buildMessages(context);
	const request: OllamaChatRequest = {
		model: model.id,
		messages,
		stream: true,
	};

	const tools = options?.tools ?? context.tools;
	if (tools && tools.length > 0) {
		request.tools = tools.map(toOllamaTool);
	}

	const temperature = options?.temperature;
	const maxTokens = options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32000) : undefined);
	if (temperature !== undefined || maxTokens !== undefined) {
		request.options = {
			temperature,
			num_predict: maxTokens,
		};
	}

	return request;
}

function buildMessages(context: Context): OllamaMessage[] {
	const messages: OllamaMessage[] = [];
	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (const message of context.messages) {
		messages.push(...toOllamaMessages(message));
	}

	return messages;
}

function toOllamaMessages(message: Message): OllamaMessage[] {
	if (message.role === "user") {
		const { text, images } = flattenUserContent(message.content);
		return [{ role: "user", content: text, images: images.length > 0 ? images : undefined }];
	}

	if (message.role === "assistant") {
		const text = message.content
			.filter(isTextContent)
			.map((part) => part.text)
			.join("");
		const toolCalls = message.content.filter(isToolCall).map(toOllamaToolCall);
		return [
			{
				role: "assistant",
				content: text,
				tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
			},
		];
	}

	const text = message.content
		.filter(isTextContent)
		.map((part) => part.text)
		.join("");
	return [{ role: "tool", content: text, tool_name: message.toolName }];
}

function flattenUserContent(content: UserMessage["content"]): { text: string; images: string[] } {
	if (typeof content === "string") {
		return { text: content, images: [] };
	}

	const text: string[] = [];
	const images: string[] = [];
	for (const part of content) {
		if (part.type === "text") {
			text.push(part.text);
		} else if (part.type === "image") {
			images.push(stripDataUrl(part));
		}
	}
	return { text: text.join(""), images };
}

function stripDataUrl(image: ImageContent): string {
	const commaIndex = image.data.indexOf(",");
	return commaIndex === -1 ? image.data : image.data.slice(commaIndex + 1);
}

function toOllamaTool(tool: Tool): OllamaToolDefinition {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}

function toOllamaToolCall(toolCall: ToolCall): OllamaToolCall {
	return {
		function: {
			name: toolCall.name,
			arguments: toolCall.arguments,
		},
	};
}

async function processOllamaStream(
	body: ReadableStream<Uint8Array>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"ollama-chat">,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let currentText: TextContent | undefined;

	const finishText = () => {
		if (!currentText) return;
		stream.push({
			type: "text_end",
			contentIndex: output.content.length - 1,
			content: currentText.text,
			partial: output,
		});
		currentText = undefined;
	};

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const chunk = JSON.parse(trimmed) as OllamaChatChunk;
			if (chunk.error) {
				throw new Error(chunk.error);
			}

			if (chunk.message?.content) {
				if (!currentText) {
					currentText = { type: "text", text: "" };
					output.content.push(currentText);
					stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
				}
				currentText.text += chunk.message.content;
				stream.push({
					type: "text_delta",
					contentIndex: output.content.length - 1,
					delta: chunk.message.content,
					partial: output,
				});
			}

			if (chunk.message?.tool_calls) {
				finishText();
				for (const call of chunk.message.tool_calls) {
					const toolCall: ToolCall = {
						type: "toolCall",
						id: `${call.function.name}_${output.content.length}`,
						name: call.function.name,
						arguments: call.function.arguments,
					};
					output.content.push(toolCall);
					const contentIndex = output.content.length - 1;
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
				}
			}

			if (chunk.done) {
				finishText();
				output.stopReason = mapDoneReason(chunk.done_reason);
				if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
					output.usage.input = chunk.prompt_eval_count ?? 0;
					output.usage.output = chunk.eval_count ?? 0;
					output.usage.totalTokens = output.usage.input + output.usage.output;
					calculateCost(model, output.usage);
				}
				const reason =
					output.stopReason === "length" ? "length" : output.stopReason === "toolUse" ? "toolUse" : "stop";
				stream.push({ type: "done", reason, message: output });
				return;
			}
		}
	}

	const tail = buffer.trim();
	if (tail) {
		const chunk = JSON.parse(tail) as OllamaChatChunk;
		if (chunk.error) {
			throw new Error(chunk.error);
		}
	}

	finishText();
	stream.push({ type: "done", reason: "stop", message: output });
}

function mapDoneReason(reason: string | undefined): StopReason {
	if (reason === "length") return "length";
	if (reason === "tool_calls") return "toolUse";
	return "stop";
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function isTextContent(part: { type: string }): part is TextContent {
	return part.type === "text";
}

function isToolCall(part: { type: string }): part is ToolCall {
	return part.type === "toolCall";
}
