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
      const def = getSettingDefinition("auto_start")!;
      expect(parseSettingValue(def, "true")).toBe(true);
      expect(parseSettingValue(def, "false")).toBe(false);
    });

    it("returns a string as-is", () => {
      const def = getSettingDefinition("github_username")!;
      expect(parseSettingValue(def, "tars-bot")).toBe("tars-bot");
    });
  });

  describe("formatSettingValue", () => {
    it("formats a boolean", () => {
      const def = getSettingDefinition("auto_start")!;
      expect(formatSettingValue(def, true)).toBe("true");
      expect(formatSettingValue(def, false)).toBe("false");
    });

    it("formats a number", () => {
      const def = getSettingDefinition("port")!;
      expect(formatSettingValue(def, 8080)).toBe("8080");
    });

    it("formats a string", () => {
      const def = getSettingDefinition("github_username")!;
      expect(formatSettingValue(def, "tars-bot")).toBe("tars-bot");
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
    });

    it("coerces booleans", () => {
      expect(coerceEnvValue("auto_start", "true")).toBe("true");
      expect(coerceEnvValue("auto_start", "false")).toBe("false");
      expect(coerceEnvValue("auto_start", "maybe")).toBe("false");
    });

    it("trims string values", () => {
      expect(coerceEnvValue("github_username", "  tars  ")).toBe("tars");
    });
  });

  describe("SETTING_DEFINITIONS", () => {
    it("contains no duplicate keys", () => {
      const keys = SETTING_DEFINITIONS.map((d) => d.key);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});
