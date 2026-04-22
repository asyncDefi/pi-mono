import type { AssistantMessage } from "@mariozechner/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class ThinkingBox extends Container {
	private borderColor: (text: string) => string;
	private isStreaming: boolean;

	constructor(content: Component, borderColor: (text: string) => string, isStreaming = false) {
		super();
		this.addChild(content);
		this.borderColor = borderColor;
		this.isStreaming = isStreaming;
	}

	override render(width: number): string[] {
		const contentWidth = Math.max(1, width - 4);
		const contentLines = [...super.render(contentWidth)];

		// If empty but streaming, show a placeholder
		if (contentLines.length === 0 && this.isStreaming) {
			contentLines.push(theme.italic(theme.fg("thinkingText", "...")));
		}

		if (contentLines.length === 0) return [];

		const result: string[] = [];
		// Header with bullet and thinking level color
		result.push(`${this.borderColor("•")} ${theme.italic(theme.fg("thinkingText", "Thinking"))}`);

		// Tree-like structure for content
		for (let i = 0; i < contentLines.length; i++) {
			const isLast = i === contentLines.length - 1;
			const prefix = isLast ? "└─ " : "│  ";
			result.push(this.borderColor(prefix) + contentLines[i]);
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

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;

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
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else if (content.thinking.trim() || (isStreaming && i === message.content.length - 1)) {
					// Thinking traces in a bordered box
					const box = new ThinkingBox(
						new Markdown(content.thinking.trim(), 0, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
						theme.getThinkingBorderColor("medium"),
						isStreaming && i === message.content.length - 1,
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
