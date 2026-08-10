import assert from "node:assert/strict";
import test from "node:test";
import {
  hasOneMMarker,
  setOneMMarker,
  stripOneMMarker,
} from "./apiSettingsUtils";

test("hasOneMMarker detects the [1M] marker case-insensitively with trailing spaces", () => {
  assert.equal(hasOneMMarker("claude-sonnet-4-6[1M]"), true);
  assert.equal(hasOneMMarker("claude-opus-4-6 [1m]"), true);
  assert.equal(hasOneMMarker("deepseek-v4-pro[1M] "), true);
  assert.equal(hasOneMMarker("claude-sonnet-4-6"), false);
  assert.equal(hasOneMMarker("claude-sonnet-4-6[2M]"), false);
  assert.equal(hasOneMMarker(""), false);
});

test("stripOneMMarker removes the [1M] marker only", () => {
  assert.equal(stripOneMMarker("claude-sonnet-4-6[1M]"), "claude-sonnet-4-6");
  assert.equal(stripOneMMarker("claude-opus-4-6 [1m] "), "claude-opus-4-6");
  assert.equal(stripOneMMarker("deepseek-v4-pro[1M]"), "deepseek-v4-pro");
  assert.equal(stripOneMMarker("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(stripOneMMarker(""), "");
});

test("setOneMMarker toggles the [1M] marker", () => {
  assert.equal(setOneMMarker("claude-sonnet-4-6", true), "claude-sonnet-4-6[1M]");
  assert.equal(setOneMMarker("claude-sonnet-4-6[1M]", false), "claude-sonnet-4-6");
  // 重复设置不会叠加标记
  assert.equal(setOneMMarker("claude-sonnet-4-6[1M]", true), "claude-sonnet-4-6[1M]");
  // 空模型名不产生标记
  assert.equal(setOneMMarker("", true), "");
  assert.equal(setOneMMarker("  ", false), "");
});
