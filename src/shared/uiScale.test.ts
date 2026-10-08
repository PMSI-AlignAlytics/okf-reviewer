import { describe, expect, it } from "vitest";
import { interfaceScale } from "./uiScale.ts";

describe("interface magnification", () => {
  it("uses the original size for preferences saved before magnification existed", () => {
    expect(interfaceScale(undefined)).toBe(1);
  });
  it.each([NaN, Infinity, -Infinity])("does not send invalid %s to CSS", (value) => {
    expect(interfaceScale(value)).toBe(1);
  });
  it("bounds stored magnification and preserves supported sizes", () => {
    expect(interfaceScale(0.5)).toBe(1);
    expect(interfaceScale(5)).toBe(2);
    expect(interfaceScale(1.5)).toBe(1.5);
  });
});
