import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  waitForCallbackOrTimeout,
  withTimeout,
} from "../src/main/remoteControl/boundedWait.ts";
import {
  isPermanentFrpcFailure,
  normalizeRemoteTunnelConfig,
  parseRemoteTunnelImportBundle,
  redactTunnelText,
  renderFrpcConfig,
} from "../src/main/remoteControl/remoteTunnelSchema.ts";
import {
  buildRemoteInstallCommand,
  deriveRemoteDomains,
  extractDohIpv4Answers,
  isPublicIpv4,
  normalizeRemoteServerDeployInput,
  parseRemotePreflight,
} from "../src/main/remoteControl/remoteServerDeploymentSchema.ts";

const root = process.cwd();
const deploy = join(root, "deploy", "remote-control");
const read = (file: string): string => readFileSync(join(deploy, file), "utf8");

test("WAN listener shutdown cannot block tunnel startup forever", async () => {
  const startedAt = Date.now();
  const result = await waitForCallbackOrTimeout(() => undefined, 20);
  assert.equal(result, "timed_out");
  assert.ok(Date.now() - startedAt < 500);

  assert.equal(
    await waitForCallbackOrTimeout((done) => done(), 1_000),
    "completed",
  );
});

test("renderer bridge calls cannot leave phone requests pending forever", async () => {
  await assert.rejects(
    withTimeout(new Promise<never>(() => undefined), 20, "desktop timed out"),
    /desktop timed out/,
  );
  assert.equal(await withTimeout(Promise.resolve("ok"), 1_000, "late"), "ok");

  const mobilePage = readFileSync(
    join(root, "src", "main", "remoteControl", "mobilePage.ts"),
    "utf8",
  );
  assert.match(mobilePage, /配对已失效，请返回 Snow 扫描新的公网二维码/);
  assert.match(mobilePage, /连接桌面 Snow 超时/);
  assert.match(mobilePage, /addEventListener\("hashchange"/);
  assert.match(mobilePage, /var runPairing/);
});

test("deployment validates before persisting imported credentials", () => {
  const source = readFileSync(
    join(root, "src", "main", "remoteControl", "remoteServerDeployer.ts"),
    "utf8",
  );
  assert.match(source, /connectTransient\(config\)/);
  assert.ok(
    source.indexOf("connectTransient(config)") < source.indexOf("save(config)"),
  );
  assert.doesNotMatch(source, /save\(\{ \.\.\.importedConfig, enabled: false/);
});

test("self-hosted template keeps the FRP data port loopback-only", () => {
  const server = read("frps.toml.example");
  const caddy = read("Caddyfile.example");

  assert.match(server, /^proxyBindAddr = "127\.0\.0\.1"$/m);
  assert.match(server, /^allowPorts = \[\{ single = 18080 \}\]$/m);
  assert.match(server, /^maxPortsPerClient = 1$/m);
  assert.doesNotMatch(server, /^webServer\./m);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:18080/);
  assert.match(caddy, /health_status 401/);
  assert.match(caddy, /health_headers \{\s+Host \{\$SNOW_REMOTE_DOMAIN\}/);
});

test("FRP templates require authenticated TLS with server verification", () => {
  const server = read("frps.toml.example");
  const client = read("frpc.toml.example");

  assert.match(server, /^transport\.tls\.force = true$/m);
  assert.match(server, /^transport\.tls\.certFile = /m);
  assert.match(server, /^auth\.tokenSource\.type = "file"$/m);
  assert.match(client, /^transport\.tls\.enable = true$/m);
  assert.match(client, /^transport\.tls\.trustedCaFile = /m);
  assert.match(client, /^transport\.tls\.serverName = "frp\.example\.com"$/m);
  assert.match(client, /^auth\.tokenSource\.type = "file"$/m);
  assert.doesNotMatch(client, /^auth\.token = /m);
});

test("desktop proxy can reach only Snow's dedicated WAN listener", () => {
  const client = read("frpc.toml.example");

  assert.match(client, /^type = "tcp"$/m);
  assert.match(client, /^localIP = "127\.0\.0\.1"$/m);
  assert.match(client, /^localPort = 8800$/m);
  assert.match(client, /^remotePort = 18080$/m);
});

test("deployment manifest pins versions and SHA-256 digests", () => {
  const manifest = JSON.parse(read("versions.json")) as {
    frp: { version: string; assets: Record<string, { sha256: string }> };
    caddy: { version: string; assets: Record<string, { sha256: string }> };
  };

  assert.equal(manifest.frp.version, "0.71.0");
  assert.equal(manifest.caddy.version, "2.11.3");
  for (const product of [manifest.frp, manifest.caddy]) {
    for (const asset of Object.values(product.assets)) {
      assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    }
  }
});

test("Windows package contains the pinned frpc and deployment guide", () => {
  const resourceRoot = join(
    root,
    "resources",
    "remote-control",
    "frp",
    "win32-x64",
  );
  const manifest = JSON.parse(
    readFileSync(join(resourceRoot, "manifest.json"), "utf8"),
  ) as { executable: { file: string; sha256: string; size: number } };
  const bytes = readFileSync(join(resourceRoot, manifest.executable.file));
  assert.equal(bytes.length, manifest.executable.size);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    manifest.executable.sha256,
  );

  const packageJson = readFileSync(join(root, "package.json"), "utf8");
  assert.match(
    packageJson,
    /"from": "resources\/remote-control\/frp\/win32-x64"/,
  );
  assert.match(packageJson, /"from": "deploy\/remote-control"/);
  assert.match(packageJson, /"to": "remote-control\/deploy"/);

  const tunnelManager = readFileSync(
    join(
      root,
      "src",
      "main",
      "remoteControl",
      "remoteTunnelManager.ts",
    ),
    "utf8",
  );
  assert.match(
    tunnelManager,
    /process\.resourcesPath,\s*"remote-control",\s*"frp",\s*"win32-x64"/,
    "packaged runtime must resolve the same platform directory copied by extraResources",
  );
});

test("settings give beginners a provider-neutral built-in deployment path", () => {
  const panel = readFileSync(
    join(
      root,
      "src",
      "renderer",
      "components",
      "sidebar",
      "RemoteControlSettingsPanel.tsx",
    ),
    "utf8",
  );
  for (const phrase of [
    "同一 Wi-Fi 使用时，不需要服务器",
    "服务器公网 IP",
    "你的根域名",
    "SSH 密码",
    "检测 DNS",
    "自动部署并连接",
    "高级设置（仅供懂技术的人手动配置）",
    "轮换凭据",
    "导入已有配置包",
  ]) {
    assert.match(panel, new RegExp(phrase));
  }
});

test("beginner deployment kit is pinned, non-interactive, and emits an import bundle", () => {
  const installer = read("install-ubuntu.sh");
  const aiPrompt = read("AI_DEPLOYMENT_PROMPT.md");
  assert.match(installer, /FRP_VERSION="0\.71\.0"/);
  assert.match(installer, /CADDY_VERSION="2\.11\.3"/);
  assert.match(installer, /sha256sum --check --status/g);
  assert.match(installer, /"kind": "snow-remote-client-config"/);
  assert.match(installer, /chmod 0600 "\$CLIENT_BUNDLE"/);
  assert.match(installer, /\[--email you@example\.com\]/);
  assert.doesNotMatch(installer, /auth\.token\s*=/);
  assert.match(aiPrompt, /SSH 密码、私钥/);
  assert.match(aiPrompt, /snow-remote-client\.json/);
  assert.match(aiPrompt, /厂商不限/);
  assert.match(aiPrompt, /不要假设我使用阿里云/);
  assert.match(aiPrompt, /抢占式、竞价/);
  assert.match(aiPrompt, /Ubuntu 24\.04\/22\.04/);
});

test("built-in deployment derives fixed subdomains and rejects non-public servers", () => {
  assert.deepEqual(deriveRemoteDomains(" HTTPS://Example.COM. "), {
    rootDomain: "example.com",
    publicDomain: "snow.example.com",
    frpDomain: "frp.example.com",
  });
  assert.equal(isPublicIpv4("42.194.128.147"), true);
  for (const value of ["127.0.0.1", "10.0.0.2", "192.168.1.2", "100.64.0.1"]) {
    assert.equal(isPublicIpv4(value), false);
  }
  assert.throws(
    () =>
      normalizeRemoteServerDeployInput({
        serverIp: "192.168.1.2",
        rootDomain: "example.com",
        sshPort: 22,
        sshUsername: "root",
        authMethod: "password",
        password: "secret",
      }),
    /公网 IPv4/,
  );
});

test("DNS-over-HTTPS parsing ignores fake or malformed non-A answers", () => {
  assert.deepEqual(
    extractDohIpv4Answers({
      Answer: [
        { type: 5, data: "alias.example.com." },
        { type: 1, data: "203.0.113.10" },
        { type: 1, data: "203.0.113.10" },
        { type: 1, data: "not-an-ip" },
      ],
    }),
    ["203.0.113.10"],
  );
  assert.deepEqual(extractDohIpv4Answers({ Answer: "bad" }), []);
});

test("built-in deployment validates server preflight and shell-quotes the installer", () => {
  assert.deepEqual(
    parseRemotePreflight(
      "os=ubuntu\nversion=24.04\narch=x86_64\nprivilege=root\n",
    ),
    { os: "ubuntu", version: "24.04", arch: "x86_64", useSudo: false },
  );
  assert.throws(
    () =>
      parseRemotePreflight(
        "os=debian\nversion=12\narch=x86_64\nprivilege=root\n",
      ),
    /Ubuntu/,
  );
  assert.throws(
    () =>
      parseRemotePreflight(
        "os=ubuntu\nversion=24.04\narch=aarch64\nprivilege=root\n",
      ),
    /x86_64/,
  );
  const command = buildRemoteInstallCommand(
    "/tmp/snow-install.sh",
    { publicDomain: "snow.example.com", frpDomain: "frp.example.com" },
    true,
  );
  assert.equal(
    command,
    "sudo -n bash '/tmp/snow-install.sh' --public-domain 'snow.example.com' --frp-domain 'frp.example.com'",
  );
});

test("purchase guidance rejects fragile bargain-server recipes", () => {
  const readme = read("README.md");
  for (const phrase of [
    "长期运行的付费",
    "不要购买抢占式",
    "独立公网 IPv4",
    "厂商不限",
    "付费域名",
    "用户不需要理解或填写 FRP",
  ]) {
    assert.match(readme, new RegExp(phrase));
  }
});

test("Snow import bundle accepts only its fixed schema and reuses config validation", () => {
  const config = parseRemoteTunnelImportBundle({
    schemaVersion: 1,
    kind: "snow-remote-client-config",
    config: {
      enabled: true,
      autoConnect: true,
      serverAddr: "FRP.EXAMPLE.COM",
      serverPort: 7000,
      publicOrigin: "https://snow.example.com",
      tlsServerName: "frp.example.com",
      token: "c".repeat(48),
      caCertificate:
        "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----",
    },
  });
  assert.equal(config.serverAddr, "frp.example.com");
  assert.equal(config.enabled, true);
  assert.throws(
    () =>
      parseRemoteTunnelImportBundle({
        schemaVersion: 2,
        kind: "snow-remote-client-config",
      }),
    /版本不受支持/,
  );
  assert.throws(
    () =>
      parseRemoteTunnelImportBundle({
        schemaVersion: 1,
        kind: "snow-remote-client-config",
        config: { ...config, publicOrigin: "http://snow.example.com" },
      }),
    /HTTPS/,
  );
});

test("managed tunnel schema rejects unsafe server and credential inputs", () => {
  const base = {
    enabled: true,
    autoConnect: true,
    serverAddr: "frp.example.com",
    serverPort: 7000,
    publicOrigin: "https://snow.example.com",
    tlsServerName: "frp.example.com",
    token: "a".repeat(48),
    caCertificate:
      "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----",
  };
  assert.throws(
    () =>
      normalizeRemoteTunnelConfig({
        ...base,
        publicOrigin: "http://snow.example.com",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      normalizeRemoteTunnelConfig({
        ...base,
        serverAddr: "https://evil.test/x",
      }),
    /纯主机名/,
  );
  assert.throws(
    () => normalizeRemoteTunnelConfig({ ...base, token: "short" }),
    /32 到 512/,
  );
});

test("managed frpc config is fixed to one TCP proxy and keeps secrets out", () => {
  const config = normalizeRemoteTunnelConfig({
    enabled: true,
    autoConnect: true,
    serverAddr: "frp.example.com",
    serverPort: 7000,
    publicOrigin: "https://snow.example.com",
    tlsServerName: "frp.example.com",
    token: "b".repeat(48),
    caCertificate:
      "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----",
  });
  const rendered = renderFrpcConfig(config, {
    tokenFile: "C:\\private\\token.txt",
    caFile: "C:\\private\\ca.crt",
    localPort: 49152,
  });
  assert.match(rendered, /localIP = "127\.0\.0\.1"/);
  assert.match(rendered, /localPort = 49152/);
  assert.match(rendered, /remotePort = 18080/);
  assert.match(rendered, /trustedCaFile/);
  assert.doesNotMatch(rendered, /b{48}/);
  assert.equal((rendered.match(/\[\[proxies\]\]/g) ?? []).length, 1);
  assert.match(redactTunnelText("token=secret-value"), /\[REDACTED\]/);
});

test("credential and certificate exits do not retry forever", () => {
  assert.equal(isPermanentFrpcFailure("authorization failed"), true);
  assert.equal(
    isPermanentFrpcFailure("x509: certificate signed by unknown authority"),
    true,
  );
  assert.equal(
    isPermanentFrpcFailure(
      "login to the server failed: session shutdown. With loginFailExit enabled",
    ),
    true,
  );
  assert.equal(
    isPermanentFrpcFailure("dial tcp: connectex: connection refused"),
    false,
  );
  assert.equal(isPermanentFrpcFailure("i/o timeout"), false);
});
