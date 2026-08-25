export class KnownCredentialPolicyError extends Error {
  readonly code = "known_credential_pattern";

  constructor(message: string) {
    super(message);
    this.name = "KnownCredentialPolicyError";
  }
}

const prohibitedNormalizedKeys = new Set([
  "auth",
  "oauth",
  "oauthtoken",
  "credential",
  "credentials",
  "devicetoken",
  "token",
  "password",
  "privatekey",
  "clientsecret",
  "sessiontoken",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "authorization",
  "cookie",
  "secret",
]);

const knownCredentialString = new RegExp(
  [
    "Bearer\\s+[A-Za-z0-9._~+/=-]{16,}",
    "\\bsk-[A-Za-z0-9_-]{16,}",
    "\\bghp_[A-Za-z0-9]{20,}",
    "\\bgithub_pat_[A-Za-z0-9_]{20,}",
    "\\beyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b",
    "-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----",
  ].join("|"),
  "u",
);

function normalizedKey(key: string): string {
  return key
    .normalize("NFKC")
    .replaceAll(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

/** Rejects known credential shapes; this is a policy, not a proof of secrecy. */
export function assertMatchesKnownCredentialPolicy(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (knownCredentialString.test(candidate)) {
        throw new KnownCredentialPolicyError(
          "Fixture matches a known credential string pattern",
        );
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    for (const [key, item] of Object.entries(candidate)) {
      const normalized = normalizedKey(key);
      if (normalized === "apikeysource") {
        if (item === "none") continue;
        throw new KnownCredentialPolicyError(
          "Fixture matches a known credential policy key",
        );
      }
      if (prohibitedNormalizedKeys.has(normalized)) {
        throw new KnownCredentialPolicyError(
          "Fixture matches a known credential policy key",
        );
      }
      visit(item);
    }
  };
  visit(value);
}
