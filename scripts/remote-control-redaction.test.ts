import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveToolText } from "../src/renderer/components/remoteControlRedaction.ts";

test("redacts remote tool credentials while preserving field labels", () => {
  const secrets = [
    "headerSecret1234567890",
    "cookieSecret1234567890",
    "setCookieSecret1234567890",
    "standaloneBearer1234567890",
    "apiSecret1234567890",
    "accessSecret1234567890",
    "refreshSecret1234567890",
    "passwordSecret1234567890",
    "clientSecret1234567890",
    "querySecret1234567890",
    "sk-SYNTHETIC_TEST_KEY_1234567890",
  ];
  const input = [
    `Authorization: Bearer ${secrets[0]}`,
    `Cookie: sid=${secrets[1]}`,
    `Set-Cookie: sid=${secrets[2]}; HttpOnly`,
    `proxy output Bearer ${secrets[3]}`,
    JSON.stringify({
      api_key: secrets[4],
      accessToken: secrets[5],
      refresh_token: secrets[6],
      password: secrets[7],
      client_secret: secrets[8],
    }),
    `https://example.invalid/callback?token=${secrets[9]}`,
    `provider key: ${secrets[10]}`,
  ].join("\n");

  const output = redactSensitiveToolText(input);
  assert.ok(output);
  for (const secret of secrets) {
    assert.equal(
      output.includes(secret),
      false,
      `credential leaked: ${secret}`,
    );
  }
  assert.match(output, /Authorization:\s*\[REDACTED\]/);
  assert.match(output, /Cookie:\s*\[REDACTED\]/);
  assert.match(output, /Set-Cookie:\s*\[REDACTED\]/);
  assert.match(output, /Bearer \[REDACTED\]/);
  assert.match(output, /"api_key":"\[REDACTED\]"/);
  assert.match(output, /token=\[REDACTED\]/);
  assert.match(output, /\[REDACTED_API_KEY\]/);
});

test("does not broadly damage ordinary code or non-sensitive logs", () => {
  const ordinary = [
    "const token = getToken();",
    "const secret = calculateSecret();",
    "const apiKey = process.env.API_KEY;",
    "authorization = granted;",
    // Environment access remains readable in ordinary source snippets.
    'console.log("token: ready");',
    "short token=abc123;",
    "CookieJar.add(item);",
    "HTTP 200: build completed successfully",
    "The secret garden is a normal sentence.",
  ].join("\n");

  assert.equal(redactSensitiveToolText(ordinary), ordinary);
});

test("is undefined-safe and idempotent", () => {
  assert.equal(redactSensitiveToolText(undefined), undefined);
  const once = redactSensitiveToolText(
    'password="syntheticPassword123456" token=syntheticToken123456',
  );
  assert.equal(redactSensitiveToolText(once), once);
});
