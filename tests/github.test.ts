import { describe, expect, it } from "vitest";

import { hasAnyLabel } from "../src/github.js";
import type { Issue } from "../src/types.js";

describe("hasAnyLabel", () => {
  it("matches excluded labels", () => {
    const issue: Issue = {
      number: 1,
      title: "Test issue",
      body: "",
      htmlUrl: "https://example.com",
      labels: [{ name: "tars-working" }, { name: "documentation" }],
    };

    expect(hasAnyLabel(issue, ["needs-clarification", "tars-working"])).toBe(true);
  });

  it("returns false when no labels match", () => {
    const issue: Issue = {
      number: 2,
      title: "Other issue",
      body: "",
      htmlUrl: "https://example.com",
      labels: [{ name: "enhancement" }],
    };

    expect(hasAnyLabel(issue, ["needs-clarification", "tars-working"])).toBe(false);
  });
});
