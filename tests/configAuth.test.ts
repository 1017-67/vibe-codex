import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loadConfig.js";

describe("auth config hardening", () => {
  it("rejects short URL tokens when URL token auth is enabled", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      ALLOW_URL_TOKEN_AUTH: "true",
      URL_TOKEN: "vibe_short",
      URL_TOKEN_MIN_LENGTH: "32",
    })).toThrow(/shorter/);
  });

  it("rejects URL tokens that do not match the required prefix", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      ALLOW_URL_TOKEN_AUTH: "true",
      URL_TOKEN: "wrong_prefix_token_that_is_long_enough",
      URL_TOKEN_REQUIRED_PREFIX: "vibe_",
      URL_TOKEN_MIN_LENGTH: "32",
    })).toThrow(/PREFIX/);
  });

  it("accepts a long prefixed URL token", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ALLOW_URL_TOKEN_AUTH: "true",
      URL_TOKEN: "vibe_0123456789abcdef0123456789abcdef",
      URL_TOKEN_MIN_LENGTH: "32",
    });
    expect(config.allowUrlTokenAuth).toBe(true);
    expect(config.urlToken).toBe("vibe_0123456789abcdef0123456789abcdef");
  });
});
