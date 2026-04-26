import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.js";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.js";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { theme } from "../theme/theme.js";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

const TOOL_ARGS_PREVIEW_MAX_LENGTH = 120;

class PrefixedResultComponent implements Component {
	private inner: Component;

	constructor(inner: Component) {
		this.inner = inner;
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	render(width: number): string[] {
		// Reserve 2 columns for "└ " / "  ".
		const lines = this.inner.render(Math.max(0, width - 2));
		if (lines.length === 0) return ["└"];
		return lines.map((line, idx) => (idx === 0 ? `└ ${line}` : `  ${line}`));
	}
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private headerText: Text;
	private bracketText: Text;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();
		this.headerText = new Text("", 0, 0);
		this.bracketText = new Text("", 0, 0);

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private formatArgsPreview(): string | undefined {
		if (this.args === undefined || this.args === null) {
			return undefined;
		}
		if (
			typeof this.args === "object" &&
			!Array.isArray(this.args) &&
			Object.keys(this.args as Record<string, unknown>).length === 0
		) {
			return undefined;
		}

		let preview: string;
		try {
			preview = JSON.stringify(this.args);
		} catch {
			preview = String(this.args);
		}
		if (!preview || preview === "{}") {
			return undefined;
		}
		if (preview.length <= TOOL_ARGS_PREVIEW_MAX_LENGTH) {
			return preview;
		}
		return `${preview.slice(0, TOOL_ARGS_PREVIEW_MAX_LENGTH - 3)}...`;
	}

	private createCallFallback(includeToolName = true): Component {
		const argsPreview = this.formatArgsPreview();
		const toolName = theme.fg("toolTitle", theme.bold(this.toolName));
		if (!argsPreview) {
			return new Text(includeToolName ? toolName : "", 0, 0);
		}
		const preview = theme.fg("dim", argsPreview);
		return new Text(includeToolName ? `${toolName} ${preview}` : preview, 0, 0);
	}

	private updateHeader(): void {
		const icon = this.isPartial ? "◌" : "●";
		this.headerText.setText(theme.fg("toolTitle", theme.bold(`${icon} ${this.toolName}`)));
		// Keep the bracket subtle; use muted so it reads like a connector.
		this.bracketText.setText(theme.fg("muted", "└"));
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	private isComponentEmpty(component: Component): boolean {
		if (component instanceof Container || component instanceof Box) {
			return component.children.length === 0 || component.children.every((child) => this.isComponentEmpty(child));
		}
		return component.render(1).length === 0;
	}

	private asPrefixedResult(component: Component): Component {
		return new PrefixedResultComponent(component);
	}

	private addPrefixedResult(container: Container | Box, component: Component | undefined): boolean {
		if (!component || this.isComponentEmpty(component)) {
			return false;
		}
		container.addChild(this.asPrefixedResult(component));
		return true;
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		this.updateHeader();
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			let callPreviewComponent: Component | undefined;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			// Tools with renderShell "self" are expected to render their own framing. Preserve that behavior.
			if (this.getRenderShell() !== "self") {
				renderContainer.addChild(this.headerText);
				hasContent = true;

				const callRenderer = this.getCallRenderer();
				if (callRenderer) {
					try {
						const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
						this.callRendererComponent = component;
						callPreviewComponent = component;
					} catch {
						this.callRendererComponent = undefined;
					}
				} else {
					this.callRendererComponent = undefined;
					callPreviewComponent = this.createCallFallback(false);
				}
			} else {
				const callRenderer = this.getCallRenderer();
				if (!callRenderer) {
					const component = this.createCallFallback();
					if (!this.isComponentEmpty(component)) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
						this.callRendererComponent = component;
						if (!this.isComponentEmpty(component)) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					} catch {
						this.callRendererComponent = undefined;
						const component = this.createCallFallback();
						if (!this.isComponentEmpty(component)) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (this.addPrefixedResult(renderContainer, component)) {
						hasContent = true;
					} else if (
						this.getRenderShell() !== "self" &&
						this.addPrefixedResult(renderContainer, callPreviewComponent)
					) {
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						if (this.addPrefixedResult(renderContainer, component)) {
							hasContent = true;
						} else if (
							this.getRenderShell() !== "self" &&
							this.addPrefixedResult(renderContainer, callPreviewComponent)
						) {
							hasContent = true;
						}
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (this.addPrefixedResult(renderContainer, component)) {
							hasContent = true;
						} else if (
							this.getRenderShell() !== "self" &&
							this.addPrefixedResult(renderContainer, callPreviewComponent)
						) {
							hasContent = true;
						}
					}
				}
			} else if (this.getRenderShell() !== "self") {
				if (this.addPrefixedResult(renderContainer, callPreviewComponent)) {
					hasContent = true;
				} else {
					// No result yet: show the bracket line alone.
					renderContainer.addChild(this.bracketText);
					hasContent = true;
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		// Fallback formatting (when no tool definition exists): tool name, bracket, then output.
		const icon = this.isPartial ? "◌" : "●";
		const output = this.getTextOutput();
		if (!output) {
			const argsPreview = this.formatArgsPreview();
			const bracket = argsPreview ? `└ ${argsPreview}` : "└";
			return `${theme.fg("toolTitle", theme.bold(`${icon} ${this.toolName}`))}\n${theme.fg("muted", bracket)}`;
		}
		const lines = output.split("\n");
		const first = lines[0] ?? "";
		const rest = lines.slice(1);
		let text = `${theme.fg("toolTitle", theme.bold(`${icon} ${this.toolName}`))}\n${theme.fg("muted", `└ ${first}`)}`;
		if (rest.length > 0) {
			text += `\n${rest.map((l) => theme.fg("toolOutput", `  ${l}`)).join("\n")}`;
		}
		return text;
	}
}
