import assert from "node:assert/strict";
import test from "node:test";
import { MOBILE_HTML } from "../src/main/remoteControl/mobilePage.ts";

test("action menu lives in a top-level overlay and supports constrained scrolling", () => {
  const composerStart = MOBILE_HTML.indexOf('<div class="composer-shell">');
  const composerEnd = MOBILE_HTML.indexOf('</div></div>\n    <div id="remotePanelScrim"');
  const actionOverlay = MOBILE_HTML.indexOf('id="actionOverlay"');

  assert.ok(composerStart >= 0 && composerEnd > composerStart);
  assert.ok(actionOverlay > composerEnd, "action overlay must not be clipped by composer");
  assert.match(
    MOBILE_HTML,
    /\$\("actionOverlay"\)\.appendChild\(actionSheet\)/,
    "the menu must be moved out of the paint-contained composer before interaction",
  );
  assert.match(MOBILE_HTML, /\.action-overlay\{position:fixed;inset:0;/);
  assert.match(MOBILE_HTML, /\.action-sheet\{[^}]*position:fixed;[^}]*overflow-y:auto;/);
  assert.match(MOBILE_HTML, /id="actionBackdrop"/);
  assert.match(MOBILE_HTML, /\$\("actionBackdrop"\)\.onclick=function\(\)\{closeOverlays\(false\)\}/);
  assert.match(MOBILE_HTML, /window\.addEventListener\("resize",positionActions\)/);
});

test("mobile controls and Snow mark use semantic theme colors", () => {
  for (const variable of [
    "--control-bg",
    "--control-fg",
    "--secondary-control-bg",
    "--secondary-control-fg",
    "--disabled-control-bg",
    "--disabled-control-fg",
    "--mark-bg",
    "--mark-fg",
  ]) {
    assert.ok(MOBILE_HTML.includes(variable), `missing theme variable ${variable}`);
  }
  assert.match(MOBILE_HTML, /\.empty-mark\{[^}]*background:var\(--mark-bg\);[^}]*color:var\(--mark-fg\)/);
  assert.match(MOBILE_HTML, /\.send-button\{[^}]*background:var\(--control-bg\);[^}]*color:var\(--control-fg\)/);
  assert.match(MOBILE_HTML, /\.send-button:disabled\{[^}]*background:var\(--disabled-control-bg\);[^}]*color:var\(--disabled-control-fg\)/);
  assert.match(
    MOBILE_HTML,
    /html\[data-theme="light"\]\{[^}]*--control-bg:#168a52;[^}]*--control-fg:#fff/,
  );
});
