export type DomainValidationErrorCode =
  | "EMPTY_DOMAIN"
  | "INVALID_DOMAIN"
  | "PRIVATE_HOST"
  | "IP_ADDRESS_NOT_ALLOWED"
  | "URL_CREDENTIALS_NOT_ALLOWED"
  | "PORT_NOT_ALLOWED"
  | "UNSUPPORTED_PROTOCOL";

export type DomainValidationResult =
  | { ok: true; domain: string }
  | { ok: false; code: DomainValidationErrorCode; message: string };

const ERROR_MESSAGES: Record<DomainValidationErrorCode, string> = {
  EMPTY_DOMAIN: "Enter a domain to search.",
  INVALID_DOMAIN: "Enter a valid public domain name.",
  PRIVATE_HOST: "Only public domain names can be searched.",
  IP_ADDRESS_NOT_ALLOWED: "IP addresses cannot be searched.",
  URL_CREDENTIALS_NOT_ALLOWED: "URLs containing credentials are not allowed.",
  PORT_NOT_ALLOWED: "URLs containing a port are not allowed.",
  UNSUPPORTED_PROTOCOL: "Only HTTP and HTTPS URLs are supported.",
};

const fail = (code: DomainValidationErrorCode): DomainValidationResult => ({
  ok: false,
  code,
  message: ERROR_MESSAGES[code],
});

export function normalizeDomain(input: string): DomainValidationResult {
  const value = input.trim();
  if (!value) {
    return fail("EMPTY_DOMAIN");
  }

  let url: URL;
  try {
    const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    url = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    return fail("INVALID_DOMAIN");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("UNSUPPORTED_PROTOCOL");
  }
  if (url.username || url.password) {
    return fail("URL_CREDENTIALS_NOT_ALLOWED");
  }
  if (url.port) {
    return fail("PORT_NOT_ALLOWED");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.includes(":") || /^\[.*\]$/.test(hostname) || /^\d+(?:\.\d+){3}$/.test(hostname)) {
    return fail("IP_ADDRESS_NOT_ALLOWED");
  }

  const labels = hostname.split(".");
  const privateSuffixes = ["local", "localhost", "internal", "home", "lan"];
  if (labels.length < 2 || privateSuffixes.includes(labels.at(-1) ?? "")) {
    return fail("PRIVATE_HOST");
  }

  const validLabel = /^(?!-)[a-z\d-]{1,63}(?<!-)$/;
  const finalLabel = labels.at(-1) ?? "";
  if (
    hostname.length > 253 ||
    labels.some((label) => !validLabel.test(label)) ||
    !/^(?:[a-z]{2,63}|xn--[a-z\d-]{2,59})$/.test(finalLabel)
  ) {
    return fail("INVALID_DOMAIN");
  }

  return { ok: true, domain: hostname };
}
