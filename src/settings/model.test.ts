import { describe, expect, it } from "vitest";
import {
  SETTING_DEFINITIONS,
  getSettingDefinition,
  parseSettingValue,
  formatSettingValue,
  coerceEnvValue,
} from "./model.js";

describe("settings/model", () => {
  describe("getSettingDefinition", () => {
    it("returns a known setting by key", () => {
      const def = getSettingDefinition("port");
      expect(def).toBeDefined();
      expect(def?.type).toBe("number");
    });

    it("returns undefined for an unknown key", () => {
      expect(getSettingDefinition("no_such_key")).toBeUndefined();
    });
  });

  describe("parseSettingValue", () => {
    it("parses a number", () => {
      const def = getSettingDefinition("port")!;
      expect(parseSettingValue(def, "8080")).toBe(8080);
    });

    it("returns 0 for an invalid number", () => {
      const def = getSettingDefinition("port")!;
      expect(parseSettingValue(def, "abc")).toBe(0);
    });

    it("parses a boolean", () => {
      const def = getSettingDefinition("self_report_enabled")!;
      expect(parseSettingValue(def, "true")).toBe(true);
      expect(parseSettingValue(def, "false")).toBe(false);
    });

    it("returns a string as-is", () => {
      const def = getSettingDefinition("github_username")!;
      expect(parseSettingValue(def, "yolomatic-bot")).toBe("yolomatic-bot");
    });
  });

  describe("formatSettingValue", () => {
    it("formats a boolean", () => {
      const def = getSettingDefinition("self_report_enabled")!;
      expect(formatSettingValue(def, true)).toBe("true");
      expect(formatSettingValue(def, false)).toBe("false");
    });

    it("formats a number", () => {
      const def = getSettingDefinition("port")!;
      expect(formatSettingValue(def, 8080)).toBe("8080");
    });

    it("formats a string", () => {
      const def = getSettingDefinition("github_username")!;
      expect(formatSettingValue(def, "yolomatic-bot")).toBe("yolomatic-bot");
    });
  });

  describe("coerceEnvValue", () => {
    it("returns env value for unknown keys", () => {
      expect(coerceEnvValue("unknown", "hello")).toBe("hello");
    });

    it("returns undefined for empty trimmed values", () => {
      expect(coerceEnvValue("port", "  ")).toBeUndefined();
    });

    it("returns undefined for invalid numbers", () => {
      expect(coerceEnvValue("port", "abc")).toBeUndefined();
    });

    it("returns undefined for negative numbers", () => {
      expect(coerceEnvValue("port", "-5")).toBeUndefined();
    });

    it("coerces valid numbers", () => {
      expect(coerceEnvValue("port", "8080")).toBe("8080");
      expect(coerceEnvValue("github_poll_interval_ms", "30000")).toBe("30000");
    });

    it("coerces booleans", () => {
      expect(coerceEnvValue("self_report_enabled", "true")).toBe("true");
      expect(coerceEnvValue("self_report_enabled", "false")).toBe("false");
      expect(coerceEnvValue("self_report_enabled", "maybe")).toBe("false");
    });

    it("trims string values", () => {
      expect(coerceEnvValue("github_username", "  yolomatic  ")).toBe("yolomatic");
    });
  });

  describe("SETTING_DEFINITIONS", () => {
    it("contains no duplicate keys", () => {
      const keys = SETTING_DEFINITIONS.map((d) => d.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("assigns a category to every definition", () => {
      for (const def of SETTING_DEFINITIONS) {
        expect(def.category).toBeTruthy();
      }
    });

    it("groups settings into expected categories", () => {
      expect(getSettingDefinition("github_token")?.category).toBe("github-integration");
      expect(getSettingDefinition("admin_github_username")?.category).toBe("authentication");
      expect(getSettingDefinition("port")?.category).toBe("server");
      expect(getSettingDefinition("workspaces_dir")?.category).toBe("file-system");
      expect(getSettingDefinition("max_worktrees")?.category).toBe("git-worktrees");
      expect(getSettingDefinition("self_report_enabled")?.category).toBe("agent-behavior");
      expect(getSettingDefinition("pi_agent_model")?.category).toBe("ai-llm");
      expect(getSettingDefinition("log_level")?.category).toBe("logging");
      expect(getSettingDefinition("issue_new_comment_enabled")?.category).toBe("issues");
      expect(getSettingDefinition("issue_admin_link_in_comments_enabled")?.category).toBe("issues");
      expect(getSettingDefinition("admin_base_url")?.category).toBe("server");
    });

    it("defines the issue comment and admin-link settings with expected defaults", () => {
      expect(getSettingDefinition("issue_new_comment_enabled")?.default).toBe("true");
      expect(getSettingDefinition("issue_new_comment_enabled")?.type).toBe("boolean");
      expect(getSettingDefinition("issue_admin_link_in_comments_enabled")?.default).toBe("true");
      expect(getSettingDefinition("issue_admin_link_in_comments_enabled")?.type).toBe("boolean");
      expect(getSettingDefinition("admin_base_url")?.default).toBe("");
      expect(getSettingDefinition("admin_base_url")?.type).toBe("string");
    });

    it("coerces the issue toggle and admin base url env values", () => {
      expect(coerceEnvValue("issue_new_comment_enabled", "true")).toBe("true");
      expect(coerceEnvValue("issue_new_comment_enabled", "false")).toBe("false");
      expect(coerceEnvValue("issue_new_comment_enabled", "maybe")).toBe("false");
      expect(coerceEnvValue("issue_admin_link_in_comments_enabled", "true")).toBe("true");
      expect(coerceEnvValue("admin_base_url", "  http://host/admin  ")).toBe("http://host/admin");
      expect(coerceEnvValue("admin_base_url", "  ")).toBeUndefined();
    });

    it("defines GitHub event ingestion settings", () => {
      expect(getSettingDefinition("github_event_mode")?.default).toBe("webhook");
      expect(getSettingDefinition("github_poll_interval_ms")?.default).toBe("60000");
    });

    it("defaults pi_agent_provider to ollama and keeps it in the ai-llm category", () => {
      const provider = getSettingDefinition("pi_agent_provider");
      expect(provider).toBeDefined();
      expect(provider?.default).toBe("ollama");
      expect(provider?.envVar).toBe("PI_AGENT_PROVIDER");
      expect(provider?.category).toBe("ai-llm");
      expect(provider?.description).not.toContain("The only supported provider");
    });

    it("defines the sensitive openai_api_key setting in the ai-llm category", () => {
      const apiKey = getSettingDefinition("openai_api_key");
      expect(apiKey).toBeDefined();
      expect(apiKey?.envVar).toBe("OPENAI_API_KEY");
      expect(apiKey?.category).toBe("ai-llm");
      expect(apiKey?.sensitive).toBe(true);
      expect(apiKey?.requiresRestart).toBe(true);
      expect(apiKey?.type).toBe("string");
    });

    it("exposes a configurable ollama_container_name setting defaulting to yolomatic-ollama", () => {
      const container = getSettingDefinition("ollama_container_name");
      expect(container).toBeDefined();
      expect(container?.default).toBe("yolomatic-ollama");
      expect(container?.envVar).toBe("OLLAMA_CONTAINER_NAME");
      expect(container?.category).toBe("ai-llm");
      expect(container?.type).toBe("string");
    });

    it("coerces the ollama container name env value", () => {
      expect(coerceEnvValue("ollama_container_name", "  my-ollama  ")).toBe("my-ollama");
      expect(coerceEnvValue("ollama_container_name", "  ")).toBeUndefined();
    });
  });
});
