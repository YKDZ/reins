export class KnownCredentialPolicyError extends Error {
  readonly code = "known_credential_pattern";

  constructor(message: string) {
    super(message);
    this.name = "KnownCredentialPolicyError";
  }
}

const prohibitedLexicalKeys = new Set([
  "auth",
  "oauth",
  "credential",
  "credentials",
  "password",
  "authorization",
  "cookie",
  "secret",
]);

const prohibitedCompoundKeys = [
  "apikey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "oauthtoken",
  "devicetoken",
  "idtoken",
  "clientsecret",
  "privatekey",
  "secretaccesskey",
] as const;

const allowedTokenUsageKeys = new Set([
  "tokencount",
  "tokenscount",
  "tokenused",
  "tokensused",
  "tokenusage",
  "tokensusage",
  "tokenbudget",
  "tokensbudget",
  "tokenlimit",
  "tokenslimit",
  "inputtoken",
  "inputtokens",
  "outputtoken",
  "outputtokens",
  "cachecreationinputtoken",
  "cachecreationinputtokens",
  "cachereadinputtoken",
  "cachereadinputtokens",
  "ephemeral1hinputtoken",
  "ephemeral1hinputtokens",
  "ephemeral5minputtoken",
  "ephemeral5minputtokens",
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

function lexicalKeyParts(key: string): string[] {
  return key
    .normalize("NFKC")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

function isCredentialKey(key: string, normalized: string): boolean {
  if (prohibitedCompoundKeys.some((marker) => normalized.includes(marker))) {
    return true;
  }
  const parts = lexicalKeyParts(key);
  if (parts.some((part) => prohibitedLexicalKeys.has(part))) return true;
  if (
    parts.some((part) => part === "token" || part === "tokens") &&
    !allowedTokenUsageKeys.has(normalized)
  ) {
    return true;
  }
  return false;
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
      if (isCredentialKey(key, normalized)) {
        throw new KnownCredentialPolicyError(
          "Fixture matches a known credential policy key",
        );
      }
      visit(item);
    }
  };
  visit(value);
}
