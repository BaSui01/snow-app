import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compareSnowAgentVersions,
  getSnowAgentTarget,
  parseSnowAgentHandshake,
  supportsSnowAgentInteractiveAttach,
  verifySnowAgentHandshake,
  type SnowAgentCapabilities,
  type SnowAgentHandshake,
} from "./snowAgent";

const capabilities: SnowAgentCapabilities = {
  transactionalQueue: true,
  processGroups: true,
  resourceLimits: true,
  outputFrames: true,
  fileCas: true,
  interactiveAttach: true,
  interactiveAttachProtocolVersion: 1,
};

const signedHandshake = (): { handshake: SnowAgentHandshake; publicKey: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = JSON.stringify({
    protocolVersion: 1,
    version: "0.1.20",
    target: "linux-x64-musl",
    artifactFileName: "snow-agent-linux-x64-musl",
    artifactSha256: "a".repeat(64),
    capabilities,
  });
  return {
    handshake: parseSnowAgentHandshake({
      protocolVersion: 1,
      version: "0.1.20",
      target: "linux-x64-musl",
      artifactFileName: "snow-agent-linux-x64-musl",
      artifactSha256: "a".repeat(64),
      release: {
        keyId: "test-ed25519",
        payload,
        signature: sign(null, Buffer.from(payload), privateKey).toString("base64"),
      },
      capabilities,
    }),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

describe("snow-agent release trust", () => {
  it("accepts a matching signed release declaration", () => {
    const { handshake, publicKey } = signedHandshake();
    expect(() => verifySnowAgentHandshake(handshake, publicKey)).not.toThrow();
  });

  it("rejects a signed payload that does not match the advertised binary", () => {
    const { handshake, publicKey } = signedHandshake();
    const tampered = { ...handshake, artifactSha256: "b".repeat(64) };
    expect(() => verifySnowAgentHandshake(tampered, publicKey)).toThrow(
      "does not match the handshake"
    );
  });

  it("uses only released POSIX target mappings", () => {
    expect(
      getSnowAgentTarget({
        platform: "posix",
        remoteOs: "linux",
        remoteArch: "x86_64",
        posixShell: true,
        systemdUser: false,
        tmux: false,
        setsid: true,
        nohup: true,
        powerShell: false,
      })
    ).toBe("linux-x64-musl");
    expect(
      getSnowAgentTarget({
        platform: "posix",
        remoteOs: "linux",
        remoteArch: "aarch64",
        posixShell: true,
        systemdUser: false,
        tmux: false,
        setsid: true,
        nohup: true,
        powerShell: false,
      })
    ).toBe("linux-arm64-musl");
  });

  it("does not trust the retired boolean-only interactive declaration", () => {
    expect(
      supportsSnowAgentInteractiveAttach({
        ...capabilities,
        interactiveAttachProtocolVersion: undefined,
      })
    ).toBe(false);
    expect(supportsSnowAgentInteractiveAttach(capabilities)).toBe(true);
  });

  it("never downgrades a newer installed release", () => {
    expect(compareSnowAgentVersions("0.1.21", "0.1.20")).toBeGreaterThan(0);
    expect(compareSnowAgentVersions("0.1.20", "0.1.21")).toBeLessThan(0);
    expect(compareSnowAgentVersions("0.1.20-beta.1", "0.1.20")).toBeLessThan(0);
  });
});
