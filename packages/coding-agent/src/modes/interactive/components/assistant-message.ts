import type { AssistantMessage } from "@mariozechner/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const SPINNER_FRAMES = ["·", "•", "●", "•"];

class ThinkingBox extends Container {
	private borderColor: (text: string) => string;
	private isStreaming: boolean;
	private duration?: number;

	constructor(content: Component, borderColor: (text: string) => string, isStreaming = false, duration?: number) {
		super();
		this.addChild(content);
		this.borderColor = borderColor;
		this.isStreaming = isStreaming;
		this.duration = duration;
	}

	override render(width: number): string[] {
		const contentWidth = Math.max(1, width - 4);
		const contentLines = [...super.render(contentWidth)];

		// If empty but streaming, show a placeholder
		if (contentLines.length === 0 && this.isStreaming) {
			contentLines.push(theme.fg("thinkingText", "..."));
		}

		if (contentLines.length === 0) return [];

		const result: string[] = [];

		// Determine bullet character: spinner if streaming, static bullet if finished
		const spinnerIndex = Math.floor(Date.now() / 150) % SPINNER_FRAMES.length;
		const bullet = this.isStreaming ? SPINNER_FRAMES[spinnerIndex] : "•";

		// Determine colors: use primary color while streaming, dim gray when finished
		const bulletColor = this.isStreaming ? this.borderColor : (s: string) => theme.fg("dim", s);
		const labelColor = this.isStreaming
			? (s: string) => theme.fg("thinkingText", s)
			: (s: string) => theme.fg("dim", s);
		const branchColor = this.isStreaming ? this.borderColor : (s: string) => theme.fg("dim", s);

		// Header with bullet/spinner and duration in UPPERCASE (system voice)
		const durationText = this.duration !== undefined ? ` (${this.duration.toFixed(1)}S)` : "";
		result.push(`${bulletColor(bullet)} ${labelColor(`THINKING${durationText}`)}`);

		// Tree-like structure for content
		for (let i = 0; i < contentLines.length; i++) {
			const isLast = i === contentLines.length - 1;
			const prefix = isLast ? "└─ " : "│  ";
			result.push(branchColor(prefix) + contentLines[i]);
		}

		return result;
	}
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private lastIsStreaming = false;
	private hasToolCalls = false;
	private tui?: TUI;
	private animationTimer?: NodeJS.Timeout;
	private thinkingStartTimes = new Map<number, number>();
	private thinkingDurations = new Map<number, number>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		tui?: TUI,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.tui = tui;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage, this.lastIsStreaming);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage, this.lastIsStreaming);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage, this.lastIsStreaming);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = false): void {
		this.lastMessage = message;
		this.lastIsStreaming = isStreaming;

		// Handle animation timer for thinking spinner
		const hasActiveThinking =
			isStreaming && message.content.some((c, i) => c.type === "thinking" && i === message.content.length - 1);

		if (hasActiveThinking && this.tui && !this.animationTimer) {
			this.animationTimer = setInterval(() => {
				this.tui?.requestRender();
			}, 150);
		} else if (!hasActiveThinking && this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some((c, i) => {
			const isLast = i === message.content.length - 1;
			if (c.type === "text" && c.text.trim()) return true;
			if (c.type === "thinking") {
				if (c.thinking.trim()) return true;
				// Show thinking block even if empty if it's currently streaming
				if (isStreaming && isLast) return true;
			}
			return false;
		});

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, this.markdownTheme));
			} else if (content.type === "thinking") {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content.slice(i + 1).some((c, j) => {
					const isLastAfter = i + 1 + j === message.content.length - 1;
					if (c.type === "text" && c.text.trim()) return true;
					if (c.type === "thinking") {
						if (c.thinking.trim()) return true;
						if (isStreaming && isLastAfter) return true;
					}
					return false;
				});

				if (this.hideThinkingBlock) {
					// Show static thinking label when hidden
					this.contentContainer.addChild(
						new Text(theme.fg("thinkingText", this.hiddenThinkingLabel.toUpperCase()), 1, 0),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else if (content.thinking.trim() || (isStreaming && i === message.content.length - 1)) {
					// Thinking traces in a tree-like box.
					// Dim the content if it's no longer streaming.
					const isCurrentThinking = isStreaming && i === message.content.length - 1;

					// Track duration
					if (isCurrentThinking) {
						if (!this.thinkingStartTimes.has(i)) {
							this.thinkingStartTimes.set(i, Date.now());
						}
					} else if (this.thinkingStartTimes.has(i) && !this.thinkingDurations.has(i)) {
						this.thinkingDurations.set(i, (Date.now() - this.thinkingStartTimes.get(i)!) / 1000);
					}

					const duration = this.thinkingDurations.get(i);
					const box = new ThinkingBox(
						new Markdown(content.thinking.trim(), 0, 0, this.markdownTheme, {
							color: (text: string) => theme.fg(isCurrentThinking ? "thinkingText" : "dim", text),
						}),
						theme.getThinkingBorderColor("low"),
						isCurrentThinking,
						duration,
					);
					this.contentContainer.addChild(box);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}
