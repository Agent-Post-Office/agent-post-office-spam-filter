import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../src/util";

describe("normalizeAddress", () => {
  it("accepts single-label domains like the inbound placeholder", () => {
    expect(normalizeAddress("Invalid-Sender@Invalid")).toBe("invalid-sender@invalid");
  });
  it("accepts normal addresses", () => {
    expect(normalizeAddress(" User@Example.com ")).toBe("user@example.com");
  });
  it("rejects malformed addresses", () => {
    expect(() => normalizeAddress("no-at-sign")).toThrow();
    expect(() => normalizeAddress("a b@example.com")).toThrow();
    expect(() => normalizeAddress("a@-example.com")).toThrow();
  });
});
