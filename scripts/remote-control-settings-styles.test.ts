import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(
  new URL("../src/renderer/styles.css", import.meta.url),
  "utf8",
);

const requiredRemoteControlSelectors = [
  "remote-pairing-layout",
  "remote-pairing-qr",
  "remote-service-status",
  "remote-pairing-details",
  "remote-pairing-actions",
  "remote-pairing-note",
  "remote-pairing-message",
  "remote-tunnel-card",
  "remote-tunnel-heading",
  "remote-tunnel-status-grid",
  "remote-tunnel-guide",
  "remote-tunnel-guide-content",
  "remote-ai-prompt",
  "remote-simple-deploy-form",
  "remote-deploy-step",
  "remote-deploy-table",
  "remote-deploy-ports",
  "remote-simple-deploy-key",
  "remote-dns-check-results",
  "remote-deploy-progress",
  "remote-import-primary",
  "remote-tunnel-advanced",
  "remote-tunnel-guide-callout",
  "remote-tunnel-guide-troubleshooting",
  "remote-tunnel-form",
  "remote-tunnel-check",
  "remote-tunnel-ca",
];

test("desktop remote-control settings keep the 0.2.42 layout styles", () => {
  for (const className of requiredRemoteControlSelectors) {
    assert.match(
      styles,
      new RegExp(`\\.${className}(?:[\\s:{>,.#]|$)`),
      `missing .${className}`,
    );
  }

  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*?\.remote-pairing-layout\s*\{/,
  );
});
