import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import { CONFIG_DIR_NAME, VERSION } from "../config.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import type { ToolDefinition } from "./extensions/types.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOOL_NAME_LENGTH = 64;
const PYTHON_STDIO_ENV_DEFAULTS = {
	PYTHONUTF8: "1",
	PYTHONIOENCODING: "utf-8",
} as const;
const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];
const WINDOWS_CMD_EXTENSIONS = new Set([".bat", ".cmd"]);

type JsonObject = Record<string, unknown>;
type JsonRpcId = number | string;

export interface McpStdioConfig {
	type: "stdio";
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface McpHttpConfig {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpServer {
	name: string;
	description: string;
	configPath: string;
	config: McpServerConfig;
	sourceInfo: SourceInfo;
}

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: JsonObject;
}

export interface McpToolCallResult {
	content?: unknown[];
	isError?: boolean;
	[key: string]: unknown;
}

export interface McpClient {
	connect(signal?: AbortSignal): Promise<void>;
	listTools(signal?: AbortSignal): Promise<McpTool[]>;
	callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpToolCallResult>;
	close(): Promise<void>;
}

export type McpClientFactory = (server: McpServer, cwd: string) => McpClient;

export interface StdioMcpSpawnCommand {
	command: string;
	args: string[];
}

interface StdioMcpSpawnCommandOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	fileExists?: (path: string) => boolean;
	platform?: NodeJS.Platform;
}

export interface LoadedMcpServer {
	server: McpServer;
	client: McpClient;
	tools: LoadedMcpTool[];
}

export interface LoadedMcpTool {
	tool: McpTool;
	toolName: string;
}

export interface McpToolDetails {
	server: string;
	tool: string;
	isError?: boolean;
	rawResult: unknown;
}

export interface LoadMcpServersOptions {
	cwd: string;
}

export interface LoadMcpServersFromConfigPathOptions {
	configPath: string;
	sourceInfo?: SourceInfo;
}

export interface LoadMcpServersResult {
	servers: McpServer[];
	diagnostics: ResourceDiagnostic[];
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		out.push(item);
	}
	return out;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
			out[key] = String(raw);
		}
	}
	return out;
}

function isLikelyPythonCommand(command: string): boolean {
	const base = (command.split(/[\\/]/).pop() ?? command).toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
	return base === "python" || base === "python3" || base.startsWith("python3.") || base === "py";
}

function hasEnvKey(env: NodeJS.ProcessEnv, key: string): boolean {
	const normalized = key.toLowerCase();
	return Object.keys(env).some((envKey) => envKey.toLowerCase() === normalized);
}

export function getImplicitStdioMcpEnvKeys(
	config: McpStdioConfig,
	parentEnv: NodeJS.ProcessEnv = process.env,
): string[] {
	if (!isLikelyPythonCommand(config.command)) {
		return [];
	}
	const env: NodeJS.ProcessEnv = { ...parentEnv, ...(config.env ?? {}) };
	return Object.keys(PYTHON_STDIO_ENV_DEFAULTS).filter((key) => !hasEnvKey(env, key));
}

export function createStdioMcpProcessEnv(
	config: McpStdioConfig,
	parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...parentEnv, ...(config.env ?? {}) };
	for (const key of getImplicitStdioMcpEnvKeys(config, parentEnv)) {
		env[key] = PYTHON_STDIO_ENV_DEFAULTS[key as keyof typeof PYTHON_STDIO_ENV_DEFAULTS];
	}
	return env;
}

function getEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const normalized = key.toLowerCase();
	for (const [envKey, value] of Object.entries(env)) {
		if (envKey.toLowerCase() === normalized) {
			return value;
		}
	}
	return undefined;
}

function hasPathSeparator(command: string): boolean {
	return command.includes("/") || command.includes("\\");
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
	const raw = getEnvValue(env, "PATHEXT");
	if (!raw) return DEFAULT_WINDOWS_PATHEXT;
	const extensions = raw
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => (part.startsWith(".") ? part : `.${part}`));
	return extensions.length > 0 ? extensions : DEFAULT_WINDOWS_PATHEXT;
}

function windowsPathDirs(env: NodeJS.ProcessEnv, cwd: string): string[] {
	const raw = getEnvValue(env, "PATH");
	if (!raw) return [cwd];
	const dirs = raw.split(";").map((part) => part.trim() || cwd);
	return dirs.length > 0 ? dirs : [cwd];
}

function findWindowsCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	const fileExists = existsSync;
	return findWindowsCommandWith(command, cwd, env, fileExists);
}

function findWindowsCommandWith(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	fileExists: (path: string) => boolean,
): string | undefined {
	const hasExtension = extname(command).length > 0;
	const extensions = windowsPathExtensions(env);
	const candidatesFor = (base: string): string[] => {
		if (hasExtension) return [base];
		return [...extensions.map((extension) => `${base}${extension}`), base];
	};

	if (hasPathSeparator(command)) {
		const base = isAbsolute(command) ? command : resolve(cwd, command);
		return candidatesFor(base).find(fileExists);
	}

	for (const dir of windowsPathDirs(env, cwd)) {
		const base = resolve(dir, command);
		const found = candidatesFor(base).find(fileExists);
		if (found) return found;
	}
	return undefined;
}

function isWindowsCommandScript(command: string): boolean {
	return WINDOWS_CMD_EXTENSIONS.has(extname(command).toLowerCase());
}

export function resolveStdioMcpSpawnCommand(
	config: McpStdioConfig,
	options: StdioMcpSpawnCommandOptions,
): StdioMcpSpawnCommand {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") {
		return { command: config.command, args: config.args };
	}

	const env = options.env ?? process.env;
	const resolved = options.fileExists
		? findWindowsCommandWith(config.command, options.cwd, env, options.fileExists)
		: findWindowsCommand(config.command, options.cwd, env);
	const command = resolved ?? config.command;
	if (!isWindowsCommandScript(command)) {
		return { command, args: config.args };
	}

	return {
		command: getEnvValue(env, "ComSpec") ?? "cmd.exe",
		args: ["/d", "/c", command, ...config.args],
	};
}

function resolveConfigCwd(rawCwd: string | undefined, baseDir: string): string | undefined {
	if (!rawCwd) return undefined;
	return isAbsolute(rawCwd) ? rawCwd : resolve(baseDir, rawCwd);
}

function normalizeHttpUrl(raw: JsonObject): string | undefined {
	const url = asString(raw.url);
	if (url) return url;

	const baseUrl = asString(raw.baseUrl);
	if (!baseUrl) return undefined;
	return baseUrl.endsWith("/mcp") ? baseUrl : `${baseUrl.replace(/\/+$/, "")}/mcp`;
}

function normalizeServerConfig(raw: JsonObject, baseDir: string): McpServerConfig | undefined {
	const command = asString(raw.command);
	if (command) {
		return {
			type: "stdio",
			command,
			args: asStringArray(raw.args) ?? [],
			cwd: resolveConfigCwd(asString(raw.cwd), baseDir),
			env: asStringMap(raw.env),
		};
	}

	const url = normalizeHttpUrl(raw);
	if (url) {
		return {
			type: "http",
			url,
			headers: asStringMap(raw.headers),
		};
	}

	return undefined;
}

function serverDescription(name: string, config: McpServerConfig, rawDescription: string | undefined): string {
	if (rawDescription) return rawDescription;
	if (config.type === "http") return `MCP server at ${config.url}`;
	const command = [config.command, ...config.args].join(" ").trim();
	return command ? `MCP stdio server: ${command}` : `MCP server ${name}`;
}

export function loadMcpServersFromConfigPath(options: LoadMcpServersFromConfigPathOptions): LoadMcpServersResult {
	const configPath = resolve(options.configPath);
	const diagnostics: ResourceDiagnostic[] = [];
	const servers: McpServer[] = [];

	if (!existsSync(configPath)) {
		return { servers, diagnostics };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		diagnostics.push({
			type: "warning",
			message: error instanceof Error ? error.message : "failed to parse MCP config",
			path: configPath,
		});
		return { servers, diagnostics };
	}

	if (!isRecord(parsed)) {
		diagnostics.push({ type: "warning", message: "MCP config must be a JSON object", path: configPath });
		return { servers, diagnostics };
	}

	const rawServers = parsed.mcpServers ?? parsed.servers;
	if (!isRecord(rawServers)) {
		diagnostics.push({
			type: "warning",
			message: 'MCP config must contain an object field named "mcpServers"',
			path: configPath,
		});
		return { servers, diagnostics };
	}

	const baseDir = dirname(configPath);
	for (const [name, rawServer] of Object.entries(rawServers)) {
		if (!isRecord(rawServer)) {
			diagnostics.push({ type: "warning", message: `MCP server "${name}" must be an object`, path: configPath });
			continue;
		}
		if (rawServer.disabled === true) {
			continue;
		}

		const config = normalizeServerConfig(rawServer, baseDir);
		if (!config) {
			diagnostics.push({
				type: "warning",
				message: `MCP server "${name}" must define either command or url`,
				path: configPath,
			});
			continue;
		}

		servers.push({
			name,
			description: serverDescription(name, config, asString(rawServer.description)),
			configPath,
			config,
			sourceInfo:
				options.sourceInfo ??
				createSyntheticSourceInfo(configPath, {
					source: "local",
					scope: "project",
					baseDir,
				}),
		});
	}

	return { servers, diagnostics };
}

export function loadMcpServers(options: LoadMcpServersOptions): LoadMcpServersResult {
	return loadMcpServersFromConfigPath({
		configPath: resolve(options.cwd, CONFIG_DIR_NAME, "mcp.json"),
	});
}

function jsonRpcErrorMessage(error: unknown): string {
	if (!isRecord(error)) return String(error);
	const message = asString(error.message) ?? "MCP request failed";
	const code = typeof error.code === "number" ? ` (${error.code})` : "";
	return `${message}${code}`;
}

function validateJsonRpcResponse(value: unknown): { result: unknown } {
	if (!isRecord(value)) {
		throw new Error("MCP server returned a non-object response");
	}
	if (value.error !== undefined) {
		throw new Error(jsonRpcErrorMessage(value.error));
	}
	return { result: value.result };
}

function operationAbortedError(): Error {
	return new Error("Operation aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw operationAbortedError();
	}
}

function requestTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

class StdioMcpClient implements McpClient {
	private proc: ChildProcessWithoutNullStreams | undefined;
	private stdout: Interface | undefined;
	private nextId = 1;
	private initialized = false;
	private pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private stderrTail: string[] = [];

	constructor(
		private server: McpServer,
		private cwd: string,
	) {}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.initialized) return;
		throwIfAborted(signal);
		await this.request(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi", version: VERSION },
			},
			signal,
		);
		throwIfAborted(signal);
		this.notify("notifications/initialized", {});
		this.initialized = true;
	}

	async listTools(signal?: AbortSignal): Promise<McpTool[]> {
		await this.connect(signal);
		const result = await this.request("tools/list", {}, signal);
		if (!isRecord(result) || !Array.isArray(result.tools)) {
			return [];
		}
		return result.tools.filter(isMcpTool);
	}

	async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpToolCallResult> {
		await this.connect(signal);
		const result = await this.request("tools/call", { name, arguments: args }, signal);
		return isRecord(result) ? (result as McpToolCallResult) : { content: [{ type: "text", text: String(result) }] };
	}

	async close(): Promise<void> {
		for (const pending of this.pending.values()) {
			pending.reject(new Error("MCP server connection closed"));
		}
		this.pending.clear();
		this.stdout?.close();
		this.proc?.stdin.end();
		this.proc?.kill();
		this.proc = undefined;
		this.stdout = undefined;
		this.initialized = false;
	}

	private ensureProcess(): ChildProcessWithoutNullStreams {
		if (this.proc) return this.proc;
		const config = this.server.config;
		if (config.type !== "stdio") {
			throw new Error("internal error: stdio client requires stdio config");
		}

		const env = createStdioMcpProcessEnv(config);
		const spawnCommand = resolveStdioMcpSpawnCommand(config, {
			cwd: config.cwd ?? this.cwd,
			env,
			platform: process.platform,
		});
		// Avoid shell: true on Windows: cmd.exe may emit stderr in the console OEM
		// code page, which decodes poorly as UTF-8 in Node and obscures real errors.
		const proc = spawn(spawnCommand.command, spawnCommand.args, {
			cwd: config.cwd ?? this.cwd,
			env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc = proc;
		this.stdout = createInterface({ input: proc.stdout });
		this.stdout.on("line", (line) => this.handleStdoutLine(line));
		proc.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail.push(chunk.toString("utf-8"));
			this.stderrTail = this.stderrTail.slice(-20);
		});
		proc.on("error", (error) => this.rejectAll(error));
		proc.on("exit", (code, signal) => {
			const details = this.stderrTail.join("").trim();
			const encodingHint =
				config.type === "stdio" && isLikelyPythonCommand(config.command) && details.includes("\uFFFD")
					? "\nHint: stderr was not valid UTF-8; set PYTHONUTF8=1 and PYTHONIOENCODING=utf-8 in this MCP server env."
					: "";
			const suffix = details ? `\n${details}${encodingHint}` : "";
			this.rejectAll(
				new Error(`MCP server "${this.server.name}" exited (${code ?? signal ?? "unknown"}).${suffix}`),
			);
			this.proc = undefined;
			this.stdout = undefined;
			this.initialized = false;
		});
		return proc;
	}

	private handleStdoutLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;
		const id = parsed.id;
		if ((typeof id !== "number" && typeof id !== "string") || !this.pending.has(id)) {
			return;
		}
		const pending = this.pending.get(id);
		this.pending.delete(id);
		if (!pending) return;
		try {
			pending.resolve(validateJsonRpcResponse(parsed).result);
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
		throwIfAborted(signal);
		const proc = this.ensureProcess();
		const id = this.nextId++;
		let cleanupAbort = () => {};
		const promise = new Promise<unknown>((resolve, reject) => {
			const rejectAborted = () => {
				this.pending.delete(id);
				reject(operationAbortedError());
			};
			if (signal) {
				signal.addEventListener("abort", rejectAborted, { once: true });
				cleanupAbort = () => signal.removeEventListener("abort", rejectAborted);
			}
			this.pending.set(id, { resolve, reject });
			proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(error);
			});
		});
		return requestTimeout(promise, DEFAULT_REQUEST_TIMEOUT_MS, `MCP ${this.server.name}.${method}`).finally(() => {
			this.pending.delete(id);
			cleanupAbort();
		});
	}

	private notify(method: string, params: JsonObject): void {
		const proc = this.ensureProcess();
		proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}

function parseServerSentEvents(text: string): unknown[] {
	const events: unknown[] = [];
	let dataLines: string[] = [];
	const flush = () => {
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n").trim();
		dataLines = [];
		if (!data || data === "[DONE]") return;
		try {
			events.push(JSON.parse(data));
		} catch {
			events.push(data);
		}
	};

	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === "") {
			flush();
			continue;
		}
		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trimStart());
		}
	}
	flush();
	return events;
}

class HttpMcpClient implements McpClient {
	private nextId = 1;
	private initialized = false;
	private sessionId: string | undefined;

	constructor(private server: McpServer) {}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.initialized) return;
		throwIfAborted(signal);
		await this.request(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi", version: VERSION },
			},
			signal,
		);
		throwIfAborted(signal);
		await this.notification("notifications/initialized", {}, signal);
		this.initialized = true;
	}

	async listTools(signal?: AbortSignal): Promise<McpTool[]> {
		await this.connect(signal);
		const result = await this.request("tools/list", {}, signal);
		if (!isRecord(result) || !Array.isArray(result.tools)) {
			return [];
		}
		return result.tools.filter(isMcpTool);
	}

	async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpToolCallResult> {
		await this.connect(signal);
		const result = await this.request("tools/call", { name, arguments: args }, signal);
		return isRecord(result) ? (result as McpToolCallResult) : { content: [{ type: "text", text: String(result) }] };
	}

	async close(): Promise<void> {
		const config = this.server.config;
		if (config.type !== "http" || !this.sessionId) return;
		try {
			await fetch(config.url, {
				method: "DELETE",
				headers: {
					...(config.headers ?? {}),
					"mcp-session-id": this.sessionId,
				},
			});
		} catch {
			// Best effort close.
		}
		this.initialized = false;
		this.sessionId = undefined;
	}

	private async request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
		return validateJsonRpcResponse(response).result;
	}

	private async notification(method: string, params: JsonObject, signal?: AbortSignal): Promise<void> {
		await this.post({ jsonrpc: "2.0", method, params }, signal);
	}

	private async post(payload: JsonObject, signal?: AbortSignal): Promise<unknown> {
		throwIfAborted(signal);
		const config = this.server.config;
		if (config.type !== "http") {
			throw new Error("internal error: HTTP client requires HTTP config");
		}

		const headers: Record<string, string> = {
			...(config.headers ?? {}),
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (this.sessionId) {
			headers["mcp-session-id"] = this.sessionId;
		}

		const response = await fetch(config.url, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal,
		});
		this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;

		const text = await response.text();
		if (!response.ok) {
			throw new Error(`MCP HTTP ${response.status}: ${text || response.statusText}`);
		}
		if (!text.trim()) return {};

		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) {
			const events = parseServerSentEvents(text);
			return events[events.length - 1] ?? {};
		}
		return JSON.parse(text) as unknown;
	}
}

function isMcpTool(value: unknown): value is McpTool {
	if (!isRecord(value)) return false;
	const name = asString(value.name);
	if (!name) return false;
	return true;
}

export function createMcpClient(server: McpServer, cwd: string): McpClient {
	return server.config.type === "stdio" ? new StdioMcpClient(server, cwd) : new HttpMcpClient(server);
}

function slugPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

export function mcpToolName(serverName: string, toolName: string): string {
	const serverPart = slugPart(serverName);
	const toolPart = slugPart(toolName);
	const full = `mcp__${serverPart}__${toolPart}`;
	if (full.length <= MAX_TOOL_NAME_LENGTH) {
		return full;
	}

	const hash = createHash("sha1").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 8);
	const prefix = `mcp__${serverPart.slice(0, 16)}__`;
	const remaining = Math.max(1, MAX_TOOL_NAME_LENGTH - prefix.length - hash.length - 1);
	return `${prefix}${toolPart.slice(0, remaining)}_${hash}`;
}

function normalizeInputSchema(schema: unknown): TSchema {
	if (isRecord(schema)) {
		return Type.Unsafe(schema);
	}
	return Type.Object({}, { additionalProperties: true });
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function mcpContentToAgentContent(content: unknown[] | undefined): (TextContent | ImageContent)[] {
	if (!content || content.length === 0) {
		return [{ type: "text", text: "(no content)" }];
	}

	const out: (TextContent | ImageContent)[] = [];
	for (const item of content) {
		if (!isRecord(item)) {
			out.push({ type: "text", text: stringifyUnknown(item) });
			continue;
		}

		if (item.type === "text" && typeof item.text === "string") {
			out.push({ type: "text", text: item.text });
			continue;
		}

		if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
			out.push({ type: "image", data: item.data, mimeType: item.mimeType });
			continue;
		}

		out.push({ type: "text", text: stringifyUnknown(item) });
	}

	return out.length > 0 ? out : [{ type: "text", text: "(no content)" }];
}

export function createMcpToolDefinition(loaded: LoadedMcpServer, loadedTool: LoadedMcpTool): ToolDefinition {
	const { server, client } = loaded;
	const { tool, toolName } = loadedTool;
	const originalDescription = tool.description?.trim();
	const description = originalDescription
		? `MCP tool from "${server.name}" (${tool.name}): ${originalDescription}`
		: `MCP tool from "${server.name}" (${tool.name})`;

	return {
		name: toolName,
		label: toolName,
		description,
		promptSnippet: description,
		parameters: normalizeInputSchema(tool.inputSchema),
		async execute(_toolCallId, params: unknown, signal) {
			throwIfAborted(signal);
			const args = isRecord(params) ? params : {};
			const result = await client.callTool(tool.name, args, signal);
			throwIfAborted(signal);
			const content = mcpContentToAgentContent(result.content);
			const details: McpToolDetails = {
				server: server.name,
				tool: tool.name,
				isError: result.isError === true,
				rawResult: result,
			};
			if (result.isError === true) {
				const text = content
					.map((item) => (item.type === "text" ? item.text : `[${item.mimeType} image]`))
					.join("\n");
				throw new Error(text || `MCP tool "${tool.name}" returned an error`);
			}
			return { content, details };
		},
	};
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\r/g, "&#13;");
}

export function formatMcpServersForPrompt(servers: LoadedMcpServer[]): string {
	if (servers.length === 0) return "";

	const lines: string[] = [
		"",
		"",
		"<LOADED_MCP>",
		'Load or unload MCP servers using mcp_context with each server name (e.g. name="docs").',
		"Only loaded MCP servers expose their tools. Unload unused MCP servers to keep tool context small.",
		"",
	];

	for (const loaded of servers) {
		lines.push(
			`<MCP_SERVER name="${escapeXmlAttribute(loaded.server.name)}" description="${escapeXmlAttribute(loaded.server.description)}">`,
		);
		if (loaded.tools.length === 0) {
			lines.push("(no tools)");
		} else {
			for (const loadedTool of loaded.tools) {
				const desc = loadedTool.tool.description?.trim().replace(/\s+/g, " ") || "(no description)";
				lines.push(`- ${loadedTool.toolName} (server tool: ${loadedTool.tool.name}): ${desc}`);
			}
		}
		lines.push("</MCP_SERVER>");
		lines.push("");
	}

	lines.push("</LOADED_MCP>");
	return lines.join("\n");
}
