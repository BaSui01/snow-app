import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublicOrigin, RemoteWanAuth } from "../src/main/remoteControl/remoteWanAuth.ts";

test("normalizes a root HTTPS public origin", () => {
  assert.equal(normalizePublicOrigin("https://snow.example.com/"), "https://snow.example.com");
  assert.throws(() => normalizePublicOrigin("http://snow.example.com"));
  assert.throws(() => normalizePublicOrigin("https://snow.example.com/remote"));
  assert.throws(() => normalizePublicOrigin("https://user:pass@snow.example.com"));
});

test("pairing codes are one-time and sessions expire", () => {
  const auth = new RemoteWanAuth("https://snow.example.com");
  const pairing = auth.issuePairing(1_000);
  assert.equal(pairing.url.startsWith("https://snow.example.com/#pair="), true);
  const session = auth.exchange(pairing.code, 2_000);
  assert.ok(session);
  assert.equal(auth.exchange(pairing.code, 2_001), null);
  assert.equal(auth.authorize(session.token, session.expiresAt - 1), true);
  assert.equal(auth.authorize(session.token, session.expiresAt), false);
});

test("failed exchange does not invalidate the active pairing code", () => {
  const auth = new RemoteWanAuth("https://snow.example.com");
  const pairing = auth.issuePairing(1_000);
  assert.equal(auth.exchange("wrong-code", 2_000), null);
  assert.ok(auth.exchange(pairing.code, 2_001));
});

test("pairing failures are globally bounded without trusting proxy headers", () => {
  const auth = new RemoteWanAuth("https://snow.example.com");
  const pairing = auth.issuePairing(1_000);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal(auth.exchange(`wrong-${attempt}`, 2_000 + attempt), null);
  }
  assert.equal(auth.exchange(pairing.code, 3_000), null);
  assert.ok(auth.exchange(pairing.code, 62_100));
});

test("revocation clears pairing and active sessions", () => {
  const auth = new RemoteWanAuth("https://snow.example.com");
  const pairing = auth.issuePairing(1_000);
  const session = auth.exchange(pairing.code, 2_000);
  assert.ok(session);
  auth.issuePairing(3_000);
  auth.revokeAll();
  assert.equal(auth.currentPairing(3_001), null);
  assert.equal(auth.authorize(session.token, 3_001), false);
});
