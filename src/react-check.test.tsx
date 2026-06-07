// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

describe("check", () => {
  it("renders", async () => {
    render(<div>Hello</div>);
    expect(screen.getByText("Hello")).not.toBeNull();
  });
});
