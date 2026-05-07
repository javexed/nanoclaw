/**
 * Sensitive-data redaction for webchat.
 *
 * Applied before sending message bodies to PWA clients (and to Web Push
 * payloads) so credentials surfaced in agent output don't leak to the chat
 * surface or to push providers. v2 has no host-wide redaction layer; this is
 * a webchat-internal utility.
 */

interface RedactPattern {
  pattern: RegExp;
  label: string;
  keep?: { prefix?: number; suffix?: number };
}

const PATTERNS: RedactPattern[] = [
  // Anthropic API keys
  { pattern: /sk-ant-api03-[A-Za-z0-9_-]{80,}/g, label: 'ANTHROPIC_KEY', keep: { prefix: 14, suffix: 4 } },
  // Anthropic OAuth tokens
  { pattern: /sk-ant-oat01-[A-Za-z0-9_-]{40,}/g, label: 'ANTHROPIC_TOKEN', keep: { prefix: 14, suffix: 4 } },
  // Generic sk- keys (Stripe, OpenAI, etc.)
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, label: 'API_KEY', keep: { prefix: 3, suffix: 4 } },
  // GitHub tokens
  { pattern: /gh[ps]_[A-Za-z0-9_]{30,}/g, label: 'GITHUB_TOKEN', keep: { prefix: 4, suffix: 4 } },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, label: 'GITHUB_PAT', keep: { prefix: 11, suffix: 4 } },
  // AWS access keys
  { pattern: /AKIA[A-Z0-9]{12,}/g, label: 'AWS_KEY', keep: { prefix: 4, suffix: 4 } },
  // Slack tokens
  { pattern: /xox[bpras]-[A-Za-z0-9-]{10,}/g, label: 'SLACK_TOKEN', keep: { prefix: 5, suffix: 4 } },
  // Discord bot tokens
  {
    pattern: /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
    label: 'DISCORD_TOKEN',
    keep: { prefix: 5, suffix: 4 },
  },
  // Azure / Entra client secrets (tilde is a strong signal)
  {
    pattern: /[A-Za-z0-9_-]{8,}~[A-Za-z0-9~._-]{20,}/g,
    label: 'CLIENT_SECRET',
    keep: { prefix: 4, suffix: 4 },
  },
  // PEM private keys
  {
    pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
    label: 'PRIVATE_KEY',
  },
  // Connection strings with passwords. The user/password segments must NOT
  // contain `/` so we don't match URLs whose path happens to look like
  // `host/segment:other@thing` (false-positive that mangles benign chat).
  { pattern: /:\/\/[^/:\s]+:([^@\s/]{8,})@/g, label: 'CONN_PASSWORD', keep: { prefix: 0, suffix: 0 } },
  // Env-style secrets: KEY=value
  {
    pattern: /(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|AUTH_TOKEN|ACCESS_KEY)\s*=\s*['"]?([^\s'"`,;]{8,})['"]?/gi,
    label: 'ENV_SECRET',
  },
  // Conversational credentials. Two anti-cascade guards:
  //   1. Leading `\b` skips trigger words inside already-bracketed labels
  //      where the prior char is `_` (e.g. `password` inside `_PASSWORD:`).
  //   2. `(?!\[)` lookahead skips values that are themselves a bracketed
  //      redaction (e.g. `API_KEY=[ENV_SECRET:****]` shouldn't get re-masked).
  // Without these the PASSWORD/SECRET rules re-eat earlier rules' output and
  // the greedy `\S{4,}` can swallow following non-secret content (like the
  // host in a connection string).
  {
    pattern: /\b(?:pass(?:word)?|pwd|passcode|pin)\s*(?::|is|=)\s*['"]?(?!\[)(\S{4,})['"]?/gi,
    label: 'PASSWORD',
  },
  {
    pattern: /\b(?:secret|token|api[_-]?key|auth[_-]?key|access[_-]?key)\s*(?::|is|=)\s*['"]?(?!\[)(\S{6,})['"]?/gi,
    label: 'SECRET',
  },
];

function maskValue(value: string, label: string, keep?: { prefix?: number; suffix?: number }): string {
  const prefix = keep?.prefix ?? 0;
  const suffix = keep?.suffix ?? 0;
  if (prefix + suffix >= value.length) return `[${label}:****]`;
  const head = prefix > 0 ? value.slice(0, prefix) : '';
  const tail = suffix > 0 ? value.slice(-suffix) : '';
  return `[${label}:${head}****${tail}]`;
}

/**
 * Scan text for sensitive patterns and replace them with masked versions.
 * Returns the original text if nothing sensitive is found.
 */
export function redactSensitiveData(text: string): string {
  let result = text;
  for (const { pattern, label, keep } of PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      if (label === 'CONN_PASSWORD') {
        const colonAt = match.indexOf(':', 3);
        const atSign = match.lastIndexOf('@');
        if (colonAt >= 0 && atSign > colonAt) {
          const password = match.slice(colonAt + 1, atSign);
          return match.slice(0, colonAt + 1) + maskValue(password, label, keep) + match.slice(atSign);
        }
      }
      if (label === 'ENV_SECRET') {
        const eqIdx = match.indexOf('=');
        if (eqIdx >= 0) {
          const key = match.slice(0, eqIdx + 1);
          const val = match.slice(eqIdx + 1).replace(/^['"]|['"]$/g, '');
          return key + maskValue(val, label, { prefix: 0, suffix: 0 });
        }
      }
      if (label === 'PASSWORD' || label === 'SECRET') {
        const sep = match.match(/^(.+?(?::|is|=)\s*['"]?)(.+?)(['"]?)$/i);
        if (sep) return sep[1] + maskValue(sep[2], label, { prefix: 0, suffix: 0 }) + sep[3];
      }
      return maskValue(match, label, keep);
    });
  }
  return result;
}
