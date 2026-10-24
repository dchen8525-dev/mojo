import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../src/errorSanitizer.js";

describe("sanitizeErrorMessage", () => {
  it("redacts bearer tokens and authorization headers", () => {
    expect(sanitizeErrorMessage("Unauthorized: Bearer sk-ant-api03-aaaaaaaaaaaaaaaa")).toBe(
      "Unauthorized: Bearer {redacted}",
    );
    expect(sanitizeErrorMessage("authorization: Bearer abc.def rejected")).toBe(
      "authorization: {redacted} rejected",
    );
  });

  it("redacts provider-style keys and known token shapes", () => {
    expect(sanitizeErrorMessage("bad key sk-proj-AbC1234567890123")).toBe("bad key {secret}");
    expect(sanitizeErrorMessage("ghp_0123456789abcdefghijklmn leaked")).toBe("{secret} leaked");
    expect(sanitizeErrorMessage("AWS AKIAIOSFODNN7EXAMPLE denied")).toBe("AWS {secret} denied");
    expect(sanitizeErrorMessage("google AIzaSyA1234567890abcdefghijklmnopqrstuv failed")).toBe(
      "google {secret} failed",
    );
  });

  it("redacts other common token formats and private key blocks", () => {
    expect(sanitizeErrorMessage("github_pat_11ABCDEFG0123456789_abcdefghijklmnop rejected")).toBe(
      "{secret} rejected",
    );
    expect(sanitizeErrorMessage("glpat-abcdefghijklmnop1234 invalid")).toBe("{secret} invalid");
    expect(sanitizeErrorMessage("xoxb-123456789012-abcdefghijkl bad")).toBe("{secret} bad");
    expect(sanitizeErrorMessage(`npm_${"a".repeat(36)} failed`)).toBe("{secret} failed");
    expect(sanitizeErrorMessage("stripe sk_live_51Habcdefghijkl rejected")).toBe("stripe {secret} rejected");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(sanitizeErrorMessage(`token ${jwt} rejected`)).toBe("token {secret} rejected");
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(sanitizeErrorMessage(`load failed: ${pem}`)).toBe("load failed: {secret}");
  });

  it("redacts api keys in query strings and key-value pairs", () => {
    // Inside a URL the whole query string is dropped by URL sanitization.
    expect(sanitizeErrorMessage("GET https://api.x.com/v1?api_key=supersecret123&x=1 failed")).toBe(
      "GET https://api.x.com/v1 failed",
    );
    // Outside a URL the key-value pair is redacted in place.
    expect(sanitizeErrorMessage("invalid api_key=supersecret123 in body")).toBe(
      "invalid api_key={redacted} in body",
    );
    // Quoted values keep their quotes — only the value is redacted.
    expect(sanitizeErrorMessage('invalid api_key: "hunter2" given')).toBe(
      'invalid api_key: "{redacted}" given',
    );
  });

  it("collapses URLs to scheme+host with segmented routes", () => {
    expect(
      sanitizeErrorMessage("POST https://api.deepseek.com/chat/completions/deadbeefdeadbeefdeadbeef 400"),
    ).toBe("POST https://api.deepseek.com/chat/completions/{segment} 400");
    // URL sanitization drops userinfo entirely instead of echoing credentials.
    const out = sanitizeErrorMessage("fetch https://user:pass@host.example/path failed")!;
    expect(out).toContain("host.example/path");
    expect(out).not.toContain("user:pass");
  });

  it("redacts local file paths on unix and windows", () => {
    expect(sanitizeErrorMessage("ENOENT: /home/alice/proj/src/a.ts missing")).toBe(
      "ENOENT: /{path} missing",
    );
    expect(sanitizeErrorMessage("EPERM D:\\work\\mojo\\src\\a.ts")).toBe("EPERM {path}");
  });

  it("redacts emails and collapses control characters", () => {
    expect(sanitizeErrorMessage("login dev+ops@example.com rejected")).toBe(
      "login {email} rejected",
    );
    expect(sanitizeErrorMessage("bad\u0000\u001b[31mdata")).toBe("bad [31mdata");
  });

  it("truncates long messages after sanitizing", () => {
    const long = "x".repeat(3000) + " sk-abcdefghijklmnopqrstuvwxyz";
    const out = sanitizeErrorMessage(long)!;
    expect(out.length).toBeLessThanOrEqual(2048);
    expect(out).not.toContain("sk-");
    expect(sanitizeErrorMessage("")).toBeUndefined();
    expect(sanitizeErrorMessage(undefined)).toBeUndefined();
  });

  it("keeps ordinary errors untouched", () => {
    const msg = "Request failed with status 500 after 2 retries";
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });
});
