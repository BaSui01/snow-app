import { createHash, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, net } from "electron";
import {
  executeSshCommand,
  readSshFile,
  writeInternalSshFile,
  type SshCapabilities,
} from "./sshManager";

export const SNOW_AGENT_PROTOCOL_VERSION = 1;

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_AGENT_BYTES = 200 * 1024 * 1024;
const RELEASE_FETCH_TIMEOUT_MS = 120_000;
const SNOW_AGENT_REPOSITORY = "MayDay-wpf/snow-app";

export type SnowAgentCapabilities = {
  transactionalQueue: boolean;
  processGroups: boolean;
  resourceLimits: boolean;
  outputFrames: boolean;
  fileCas: boolean;
  interactiveAttach: boolean;
};

export type SnowAgentTarget = "linux-x64-gnu" | "darwin-x64" | "darwin-arm64";

export type SnowAgentHandshake = {
  protocolVersion: number;
  version: string;
  target: SnowAgentTarget;
  artifactFileName: string;
  artifactSha256: string;
  release: {
    keyId: string;
    payload: string;
    signature: string;
  };
  capabilities: SnowAgentCapabilities;
};

type SnowAgentReleasePayload = {
  protocolVersion: number;
  version: string;
  target: SnowAgentTarget;
  artifactFileName: string;
  artifactSha256: string;
  capabilities: SnowAgentCapabilities;
};

type SnowAgentReleaseTrust = {
  schemaVersion: 1;
  repository: typeof SNOW_AGENT_REPOSITORY;
  releaseTag: string;
  publicKey: string;
};

type InstalledSnowAgent = {
  executable: string;
  handshake: SnowAgentHandshake;
};

const requiredCapabilities = (capabilities: SnowAgentCapabilities): boolean =>
  capabilities.transactionalQueue &&
  capabilities.processGroups &&
  capabilities.resourceLimits &&
  capabilities.outputFrames &&
  capabilities.fileCas;

const sameCapabilities = (
  left: SnowAgentCapabilities,
  right: SnowAgentCapabilities
): boolean =>
  left.transactionalQueue === right.transactionalQueue &&
  left.processGroups === right.processGroups &&
  left.resourceLimits === right.resourceLimits &&
  left.outputFrames === right.outputFrames &&
  left.fileCas === right.fileCas &&
  left.interactiveAttach === right.interactiveAttach;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSnowAgentTarget = (value: unknown): value is SnowAgentTarget =>
  value === "linux-x64-gnu" || value === "darwin-x64" || value === "darwin-arm64";

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);

const isReleaseVersion = (value: string): boolean =>
  /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);

const isReleaseTag = (value: unknown): value is string =>
  typeof value === "string" && /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);

const parseCapabilities = (value: unknown): SnowAgentCapabilities | null => {
  if (!isRecord(value)) {
    return null;
  }
  const names = [
    "transactionalQueue",
    "processGroups",
    "resourceLimits",
    "outputFrames",
    "fileCas",
    "interactiveAttach",
  ] as const;
  if (!names.every((name) => typeof value[name] === "boolean")) {
    return null;
  }
  return {
    transactionalQueue: value.transactionalQueue as boolean,
    processGroups: value.processGroups as boolean,
    resourceLimits: value.resourceLimits as boolean,
    outputFrames: value.outputFrames as boolean,
    fileCas: value.fileCas as boolean,
    interactiveAttach: value.interactiveAttach as boolean,
  };
};

const parseReleasePayload = (value: unknown): SnowAgentReleasePayload => {
  if (
    !isRecord(value) ||
    value.protocolVersion !== SNOW_AGENT_PROTOCOL_VERSION ||
    typeof value.version !== "string" ||
    !isReleaseVersion(value.version) ||
    !isSnowAgentTarget(value.target) ||
    value.artifactFileName !== `snow-agent-${value.target}` ||
    !isSha256(value.artifactSha256)
  ) {
    throw new Error("snow-agent signed release payload is malformed");
  }
  const capabilities = parseCapabilities(value.capabilities);
  if (!capabilities || !requiredCapabilities(capabilities)) {
    throw new Error("snow-agent signed release payload is missing required capabilities");
  }
  return {
    protocolVersion: value.protocolVersion,
    version: value.version,
    target: value.target,
    artifactFileName: value.artifactFileName,
    artifactSha256: value.artifactSha256.toLowerCase(),
    capabilities,
  };
};

export const parseSnowAgentHandshake = (value: unknown): SnowAgentHandshake => {
  if (!isRecord(value) || value.protocolVersion !== SNOW_AGENT_PROTOCOL_VERSION) {
    throw new Error("snow-agent handshake is malformed or incompatible");
  }
  if (typeof value.version !== "string" || !isReleaseVersion(value.version)) {
    throw new Error("snow-agent handshake has an invalid version");
  }
  if (!isSnowAgentTarget(value.target)) {
    throw new Error("snow-agent handshake has an unsupported target");
  }
  if (value.artifactFileName !== `snow-agent-${value.target}`) {
    throw new Error("snow-agent handshake has an invalid artifact name");
  }
  if (!isSha256(value.artifactSha256)) {
    throw new Error("snow-agent handshake has an invalid artifact hash");
  }
  if (!isRecord(value.release)) {
    throw new Error("snow-agent handshake has no signed release declaration");
  }
  const { keyId, payload, signature } = value.release;
  if (
    typeof keyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) ||
    typeof payload !== "string" ||
    !payload ||
    typeof signature !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)
  ) {
    throw new Error("snow-agent release declaration is malformed");
  }
  const capabilities = parseCapabilities(value.capabilities);
  if (!capabilities || !requiredCapabilities(capabilities)) {
    throw new Error("snow-agent is missing required durable-job capabilities");
  }
  return {
    protocolVersion: value.protocolVersion,
    version: value.version,
    target: value.target,
    artifactFileName: value.artifactFileName,
    artifactSha256: value.artifactSha256.toLowerCase(),
    release: { keyId, payload, signature },
    capabilities,
  };
};

let cachedReleaseTrust: SnowAgentReleaseTrust | null | undefined;
let releaseTrustForTesting: SnowAgentReleaseTrust | null = null;

const releaseTrustPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "snow-agent", "trust.json")
    : join(app.getAppPath(), "resources", "snow-agent", "trust.json");

const parseReleaseTrust = (value: unknown): SnowAgentReleaseTrust => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.repository !== SNOW_AGENT_REPOSITORY ||
    !isReleaseTag(value.releaseTag) ||
    typeof value.publicKey !== "string" ||
    !value.publicKey.includes("BEGIN PUBLIC KEY")
  ) {
    throw new Error("snow-agent release trust configuration is invalid");
  }
  return {
    schemaVersion: 1,
    repository: SNOW_AGENT_REPOSITORY,
    releaseTag: value.releaseTag,
    publicKey: value.publicKey.trim(),
  };
};

const loadReleaseTrust = (): SnowAgentReleaseTrust => {
  if (releaseTrustForTesting) {
    return releaseTrustForTesting;
  }
  if (cachedReleaseTrust) {
    return cachedReleaseTrust;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(releaseTrustPath(), "utf8")) as unknown;
  } catch {
    throw new Error("snow-agent release trust configuration is unavailable");
  }
  cachedReleaseTrust = parseReleaseTrust(raw);
  return cachedReleaseTrust;
};

/** Test-only override. Production trust always comes from the packaged resource. */
export const setSnowAgentReleaseTrustForTesting = (
  trust: SnowAgentReleaseTrust | null
): void => {
  releaseTrustForTesting = trust;
  cachedReleaseTrust = undefined;
};

const trustedReleasePublicKey = (): string => {
  if (!app.isPackaged) {
    const developmentKey = process.env.SNOW_AGENT_RELEASE_PUBLIC_KEY?.trim();
    if (developmentKey) {
      return developmentKey;
    }
  }
  return loadReleaseTrust().publicKey;
};

export const verifySnowAgentHandshake = (
  handshake: SnowAgentHandshake,
  publicKey = trustedReleasePublicKey()
): void => {
  let payload: SnowAgentReleasePayload;
  try {
    payload = parseReleasePayload(JSON.parse(handshake.release.payload) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("snow-agent")) {
      throw error;
    }
    throw new Error("snow-agent signed release payload is invalid JSON");
  }
  if (
    payload.protocolVersion !== handshake.protocolVersion ||
    payload.version !== handshake.version ||
    payload.target !== handshake.target ||
    payload.artifactFileName !== handshake.artifactFileName ||
    payload.artifactSha256 !== handshake.artifactSha256 ||
    !sameCapabilities(payload.capabilities, handshake.capabilities)
  ) {
    throw new Error("snow-agent signed release payload does not match the handshake");
  }
  const signature = Buffer.from(handshake.release.signature, "base64");
  if (
    signature.length === 0 ||
    !verify(null, Buffer.from(handshake.release.payload, "utf8"), publicKey, signature)
  ) {
    throw new Error("snow-agent release signature verification failed");
  }
};

export const getSnowAgentTarget = (
  capabilities: SshCapabilities
): SnowAgentTarget | null => {
  if (!capabilities.posixShell || capabilities.platform !== "posix") {
    return null;
  }
  if (capabilities.remoteOs === "linux" && capabilities.remoteArch === "x86_64") {
    return "linux-x64-gnu";
  }
  if (capabilities.remoteOs === "darwin" && capabilities.remoteArch === "x86_64") {
    return "darwin-x64";
  }
  if (capabilities.remoteOs === "darwin" && capabilities.remoteArch === "arm64") {
    return "darwin-arm64";
  }
  return null;
};

export const canUseSnowAgent = (capabilities: SshCapabilities): boolean =>
  getSnowAgentTarget(capabilities) !== null;

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `"'"'`)}'`;

type ParsedSnowAgentVersion = {
  parts: number[];
  prerelease: string[];
};

const parseVersion = (value: string): ParsedSnowAgentVersion => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value
  );
  if (!match) {
    throw new Error(`snow-agent release version is invalid: ${value}`);
  }
  return {
    parts: match.slice(1, 4).map((part) => Number.parseInt(part, 10)),
    prerelease: match[4]?.split(".") ?? [],
  };
};

export const compareSnowAgentVersions = (left: string, right: string): number => {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  for (let index = 0; index < leftVersion.parts.length; index += 1) {
    if (leftVersion.parts[index] !== rightVersion.parts[index]) {
      return leftVersion.parts[index] > rightVersion.parts[index] ? 1 : -1;
    }
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    if (leftVersion.prerelease.length === rightVersion.prerelease.length) {
      return 0;
    }
    return leftVersion.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === rightPart) {
      continue;
    }
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    const leftNumber = /^\d+$/.test(leftPart) ? Number.parseInt(leftPart, 10) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number.parseInt(rightPart, 10) : null;
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber > rightNumber ? 1 : -1;
    }
    if (leftNumber !== null || rightNumber !== null) {
      return leftNumber !== null ? -1 : 1;
    }
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
};

const readResponse = async (
  url: string,
  maxBytes: number,
  accept: string
): Promise<Buffer> => {
  const response = await net.fetch(url, {
    signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
    headers: {
      Accept: accept,
      "User-Agent": `snow-app-snow-agent/${app.getVersion()}`,
    },
  });
  if (!response.ok) {
    throw new Error(`snow-agent release download failed: HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("snow-agent release asset exceeds the configured size limit");
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (content.length === 0 || content.length > maxBytes) {
    throw new Error("snow-agent release asset is empty or exceeds the configured size limit");
  }
  return content;
};

const releaseAssetUrl = (trust: SnowAgentReleaseTrust, asset: string): string =>
  `https://github.com/${trust.repository}/releases/download/${encodeURIComponent(
    trust.releaseTag
  )}/${encodeURIComponent(asset)}`;

const fetchRelease = async (
  target: SnowAgentTarget
): Promise<{ handshake: SnowAgentHandshake; manifest: Buffer; artifact: Buffer }> => {
  const trust = loadReleaseTrust();
  const manifestName = `snow-agent-${target}.json`;
  const manifest = await readResponse(
    releaseAssetUrl(trust, manifestName),
    MAX_MANIFEST_BYTES,
    "application/json"
  );
  let handshake: SnowAgentHandshake;
  try {
    handshake = parseSnowAgentHandshake(JSON.parse(manifest.toString("utf8")) as unknown);
  } catch (error) {
    throw new Error(
      `snow-agent release manifest is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  verifySnowAgentHandshake(handshake, trust.publicKey);
  if (handshake.target !== target) {
    throw new Error("snow-agent release manifest target does not match the remote host");
  }
  if (handshake.version !== trust.releaseTag.slice(1)) {
    throw new Error("snow-agent release manifest version does not match the packaged app");
  }
  const artifact = await readResponse(
    releaseAssetUrl(trust, handshake.artifactFileName),
    MAX_AGENT_BYTES,
    "application/octet-stream"
  );
  const actualHash = createHash("sha256").update(artifact).digest("hex");
  if (actualHash !== handshake.artifactSha256) {
    throw new Error("snow-agent release artifact does not match its signed manifest");
  }
  return { handshake, manifest, artifact };
};

const remoteAgentRoot = async (sessionId: string, target: SnowAgentTarget): Promise<string> => {
  const home = (
    await executeSshCommand(
      sessionId,
      'if [ -n "${HOME:-}" ] && [ "${HOME#/}" != "$HOME" ]; then printf "%s" "$HOME"; else exit 1; fi',
      { timeoutMs: 10_000 }
    )
  ).trim();
  if (!home.startsWith("/") || /[\u0000\r\n]/.test(home)) {
    throw new Error("snow-agent remote home directory is invalid");
  }
  return `${home}/.local/share/snow-app/agents/${target}`;
};

const remoteSha256 = async (sessionId: string, path: string): Promise<string> => {
  const output = await executeSshCommand(
    sessionId,
    [
      `if command -v sha256sum >/dev/null 2>&1; then sha256sum -- ${shellQuote(path)} | awk '{print $1}'`,
      `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- ${shellQuote(path)} | awk '{print $1}'`,
      `elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 ${shellQuote(path)} | sed 's/^.*= *//'`,
      "else exit 127; fi",
    ].join("; "),
    { timeoutMs: 20_000 }
  );
  const hash = output.trim().toLowerCase();
  if (!isSha256(hash)) {
    throw new Error("snow-agent remote hash command returned an invalid digest");
  }
  return hash;
};

const installedAgentFromManifest = async (
  sessionId: string,
  root: string
): Promise<InstalledSnowAgent | null> => {
  try {
    const manifest = await readSshFile(sessionId, `${root}/current.json`);
    if (manifest.length === 0 || manifest.length > MAX_MANIFEST_BYTES) {
      return null;
    }
    const handshake = parseSnowAgentHandshake(JSON.parse(manifest.toString("utf8")) as unknown);
    verifySnowAgentHandshake(handshake);
    const executable = `${root}/releases/${handshake.artifactSha256}/snow-agent`;
    if ((await remoteSha256(sessionId, executable)) !== handshake.artifactSha256) {
      return null;
    }
    return { executable, handshake };
  } catch {
    return null;
  }
};

const installRelease = async (
  sessionId: string,
  root: string,
  release: { handshake: SnowAgentHandshake; manifest: Buffer; artifact: Buffer }
): Promise<InstalledSnowAgent> => {
  const releaseDirectory = `${root}/releases/${release.handshake.artifactSha256}`;
  await executeSshCommand(
    sessionId,
    `umask 077; mkdir -p -- ${shellQuote(releaseDirectory)} && chmod 700 -- ${shellQuote(
      root
    )} ${shellQuote(`${root}/releases`)} ${shellQuote(releaseDirectory)}`,
    { timeoutMs: 20_000 }
  );
  const executable = `${releaseDirectory}/snow-agent`;
  await Promise.all([
    writeInternalSshFile(sessionId, executable, release.artifact),
    writeInternalSshFile(
      sessionId,
      `${releaseDirectory}/snow-agent-release.json`,
      release.manifest
    ),
  ]);
  await executeSshCommand(
    sessionId,
    `chmod 700 -- ${shellQuote(executable)} && chmod 600 -- ${shellQuote(
      `${releaseDirectory}/snow-agent-release.json`
    )}`,
    { timeoutMs: 10_000 }
  );
  if ((await remoteSha256(sessionId, executable)) !== release.handshake.artifactSha256) {
    throw new Error("snow-agent remote staging hash verification failed");
  }
  await writeInternalSshFile(sessionId, `${root}/current.json`, release.manifest);
  await executeSshCommand(sessionId, `chmod 600 -- ${shellQuote(`${root}/current.json`)}`, {
    timeoutMs: 10_000,
  });
  return { executable, handshake: release.handshake };
};

const installedAgents = new Map<string, InstalledSnowAgent>();
const installationsInFlight = new Map<string, Promise<InstalledSnowAgent>>();

const agentCacheKey = (sessionId: string): string => sessionId;

const ensureSnowAgent = async (
  sessionId: string,
  capabilities: SshCapabilities
): Promise<InstalledSnowAgent> => {
  const target = getSnowAgentTarget(capabilities);
  if (!target) {
    throw new Error("snow-agent is not published for this remote platform");
  }
  const cacheKey = agentCacheKey(sessionId);
  const cached = installedAgents.get(cacheKey);
  if (cached) {
    return cached;
  }
  const inFlight = installationsInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  const installation = (async (): Promise<InstalledSnowAgent> => {
    const root = await remoteAgentRoot(sessionId, target);
    const desired = await fetchRelease(target);
    const installed = await installedAgentFromManifest(sessionId, root);
    if (installed) {
      const comparison = compareSnowAgentVersions(
        installed.handshake.version,
        desired.handshake.version
      );
      if (comparison > 0) {
        return installed;
      }
      if (comparison === 0) {
        if (installed.handshake.artifactSha256 !== desired.handshake.artifactSha256) {
          throw new Error("snow-agent release version has conflicting signed artifact hashes");
        }
        return installed;
      }
    }
    return installRelease(sessionId, root, desired);
  })();
  installationsInFlight.set(cacheKey, installation);
  try {
    const installed = await installation;
    installedAgents.set(cacheKey, installed);
    return installed;
  } finally {
    installationsInFlight.delete(cacheKey);
  }
};

const runSnowAgent = async (
  sessionId: string,
  capabilities: SshCapabilities,
  args: string[],
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<string> => {
  const agent = await ensureSnowAgent(sessionId, capabilities);
  return executeSshCommand(
    sessionId,
    `${shellQuote(agent.executable)} ${args.map(shellQuote).join(" ")}`,
    { timeoutMs, signal }
  );
};

const parseJsonResult = (output: string, action: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!isRecord(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error(`snow-agent ${action} did not return a JSON object`);
  }
};

const verifiedAgents = new Map<string, SnowAgentHandshake>();

export const negotiateSnowAgent = async (
  sessionId: string,
  capabilities: SshCapabilities
): Promise<SnowAgentHandshake> => {
  const cacheKey = agentCacheKey(sessionId);
  const cached = verifiedAgents.get(cacheKey);
  if (cached) {
    return cached;
  }
  const output = await runSnowAgent(
    sessionId,
    capabilities,
    ["protocol", "--format=json"],
    10_000
  );
  const handshake = parseSnowAgentHandshake(parseJsonResult(output, "protocol"));
  verifySnowAgentHandshake(handshake);
  const installed = await ensureSnowAgent(sessionId, capabilities);
  if (
    handshake.target !== installed.handshake.target ||
    handshake.artifactSha256 !== installed.handshake.artifactSha256
  ) {
    throw new Error("snow-agent handshake does not match the verified installed release");
  }
  verifiedAgents.set(cacheKey, handshake);
  return handshake;
};

export const launchSnowAgentJob = async (
  sessionId: string,
  capabilities: SshCapabilities,
  jobDirectory: string,
  jobId: string,
  signal?: AbortSignal
): Promise<void> => {
  const receipt = parseJsonResult(
    await runSnowAgent(
      sessionId,
      capabilities,
      ["job", "launch", "--job-directory", jobDirectory],
      15_000,
      signal
    ),
    "job launch"
  );
  if (receipt.accepted !== true || receipt.jobId !== jobId) {
    throw new Error("snow-agent rejected the Remote Job launch");
  }
};

export type SnowAgentLivenessProbe = {
  probeId: string;
  markerToken: string;
};

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );

export const startSnowAgentLivenessProbe = async (
  sessionId: string,
  capabilities: SshCapabilities
): Promise<SnowAgentLivenessProbe> => {
  const result = parseJsonResult(
    await runSnowAgent(
      sessionId,
      capabilities,
      ["job", "self-test", "--disconnect-survival"],
      15_000
    ),
    "job self-test"
  );
  if (
    result.accepted !== true ||
    !isUuid(result.probeId) ||
    !isUuid(result.markerToken)
  ) {
    throw new Error("snow-agent did not start a disconnect-survival probe");
  }
  return { probeId: result.probeId, markerToken: result.markerToken };
};

export const inspectSnowAgentJob = async (
  sessionId: string,
  capabilities: SshCapabilities,
  jobDirectory: string
): Promise<"active" | "inactive"> => {
  const result = parseJsonResult(
    await runSnowAgent(
      sessionId,
      capabilities,
      ["job", "inspect", "--job-directory", jobDirectory]
    ),
    "job inspect"
  );
  return result.active === true ? "active" : "inactive";
};

export const cancelSnowAgentJob = async (
  sessionId: string,
  capabilities: SshCapabilities,
  jobDirectory: string
): Promise<void> => {
  const result = parseJsonResult(
    await runSnowAgent(
      sessionId,
      capabilities,
      ["job", "cancel", "--job-directory", jobDirectory]
    ),
    "job cancel"
  );
  if (result.accepted !== true) {
    throw new Error("snow-agent did not accept the Remote Job cancellation");
  }
};

export const getSnowAgentAttachCommand = async (
  sessionId: string,
  capabilities: SshCapabilities,
  jobDirectory: string
): Promise<string> => {
  const agent = await ensureSnowAgent(sessionId, capabilities);
  return `${shellQuote(agent.executable)} job attach --job-directory ${shellQuote(jobDirectory)}`;
};

export const clearSnowAgentHandshakeCacheForTesting = (): void => {
  verifiedAgents.clear();
  installedAgents.clear();
  installationsInFlight.clear();
};
