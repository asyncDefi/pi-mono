import { setKeybindings } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("includes Ollama Cloud API key login", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			AuthStorage.inMemory(),
			() => {},
			() => {},
		);
		const rendered = stripAnsi(selector.render(120).join("\n"));

		expect(rendered).toContain("Ollama Cloud");
	});

	it("shows Ollama Cloud as logged in when an API key is stored", () => {
		const authStorage = AuthStorage.inMemory({
			"ollama-cloud": { type: "api_key", key: "ollama-test-key" },
		});
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			() => {},
			() => {},
		);
		const rendered = stripAnsi(selector.render(120).join("\n"));

		expect(rendered).toContain("Ollama Cloud");
		expect(rendered).toContain("logged in");
	});
});
