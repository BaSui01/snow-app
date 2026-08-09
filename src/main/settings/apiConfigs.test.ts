import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeApiConfigInput } from "./apiConfigs";

const completeActiveProfile = {
  profileName: "test-profile",
  isActive: true,
  advancedModel: "advanced-model",
  basicModel: "basic-model",
};

test("active API profile requires an advanced model", () => {
  assert.throws(
    () =>
      normalizeApiConfigInput({
        ...completeActiveProfile,
        advancedModel: " \t\n ",
      }),
    /Advanced model is required for an active API profile/
  );
});

test("active API profile requires a basic model", () => {
  assert.throws(
    () =>
      normalizeApiConfigInput({
        ...completeActiveProfile,
        basicModel: " \t\n ",
      }),
    /Basic model is required for an active API profile/
  );
});

test("inactive API profile allows empty models", () => {
  const normalized = normalizeApiConfigInput({
    profileName: "draft-profile",
    isActive: false,
    advancedModel: " \t ",
    basicModel: "\n ",
  });

  assert.equal(normalized.advancedModel, "");
  assert.equal(normalized.basicModel, "");
  assert.equal(normalized.isActive, false);
});

test("active API profile trims model names before validation", () => {
  const normalized = normalizeApiConfigInput({
    profileName: "  trimmed-profile  ",
    isActive: true,
    apiKey: "",
    advancedModel: "  advanced-model  ",
    basicModel: "\t basic-model \n",
  });

  assert.equal(normalized.profileName, "trimmed-profile");
  assert.equal(normalized.advancedModel, "advanced-model");
  assert.equal(normalized.basicModel, "basic-model");
  assert.equal(normalized.apiKey, "");
});
