import { describe, expect, it } from "vitest";

import { normalizeDomain } from "../src/worker/domain-validation";

describe("normalizeDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["  EXAMPLE.com  ", "example.com"],
    ["https://WWW.Example.com/a/path?query=yes#fragment", "www.example.com"],
    ["example.com/a/path", "example.com"],
  ])("normalizes %s to the public hostname %s", (input, expected) => {
    expect(normalizeDomain(input)).toEqual({ ok: true, domain: expected });
  });

  it.each([
    ["", "EMPTY_DOMAIN"],
    ["   ", "EMPTY_DOMAIN"],
    ["https://user:pass@example.com", "URL_CREDENTIALS_NOT_ALLOWED"],
    ["https://example.com:8080", "PORT_NOT_ALLOWED"],
    ["ftp://example.com", "UNSUPPORTED_PROTOCOL"],
    ["192.0.2.1", "IP_ADDRESS_NOT_ALLOWED"],
    ["https://[2001:db8::1]/", "IP_ADDRESS_NOT_ALLOWED"],
    ["localhost", "PRIVATE_HOST"],
    ["printer", "PRIVATE_HOST"],
    ["service.local", "PRIVATE_HOST"],
    ["bad_domain.example", "INVALID_DOMAIN"],
    ["-bad.example.com", "INVALID_DOMAIN"],
    ["bad-.example.com", "INVALID_DOMAIN"],
    ["example..com", "INVALID_DOMAIN"],
    ["not a domain.com", "INVALID_DOMAIN"],
  ])("rejects %s with %s", (input, code) => {
    expect(normalizeDomain(input)).toMatchObject({ ok: false, code });
  });
});
