import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledTaskRunOptions } from "../../../../preload";
import { resolveAutoSendOptions } from "./autoSendOptions";

const apiConfigs = [
  { profileName: "Profile A", advancedModel: "advanced-a" },
  { profileName: "Profile B", advancedModel: " advanced-b " },
];

test("resolveAutoSendOptions keeps scheduled-task routing profile-local", async (t) => {
  await t.test("prefers a non-empty explicit task model", () => {
    assert.deepEqual(
      resolveAutoSendOptions({
        autoSendOverride: {
          apiProfile: " Profile B ",
          model: " task-model ",
        },
        apiConfigs,
        selectedModel: "selected-a",
        selectedApiProfile: "Profile A",
      }),
      { model: "task-model", apiProfile: "Profile B" }
    );
  });

  await t.test("uses the specified profile's advanced model", () => {
    assert.deepEqual(
      resolveAutoSendOptions({
        autoSendOverride: { apiProfile: "Profile B" },
        apiConfigs,
        selectedModel: "selected-a",
        selectedApiProfile: "Profile A",
      }),
      { model: "advanced-b", apiProfile: "Profile B" }
    );
  });

  await t.test("never borrows selectedModel for an unavailable task profile", () => {
    const options = resolveAutoSendOptions({
      autoSendOverride: { apiProfile: "Missing Profile" },
      apiConfigs,
      selectedModel: "selected-a",
      selectedApiProfile: "Profile A",
    });

    assert.deepEqual(options, { apiProfile: "Missing Profile" });
    assert.equal("model" in options, false);
  });

  await t.test("uses selectedModel only when the task has no profile", () => {
    assert.deepEqual(
      resolveAutoSendOptions({
        autoSendOverride: {},
        apiConfigs,
        selectedModel: " selected-a ",
        selectedApiProfile: " Profile A ",
      }),
      { model: "selected-a", apiProfile: "Profile A" }
    );
  });

  await t.test("forwards only a non-empty explicit basic-model snapshot", () => {
    const explicit = resolveAutoSendOptions({
      autoSendOverride: {
        basicModel: " title-basic ",
        thinkingStrength: " ",
      },
      apiConfigs,
      selectedModel: "selected-a",
      selectedApiProfile: "Profile A",
    });
    const blank = resolveAutoSendOptions({
      autoSendOverride: { basicModel: " " },
      apiConfigs,
      selectedModel: "selected-a",
      selectedApiProfile: "Profile A",
    });

    assert.equal(explicit.basicModel, "title-basic");
    assert.equal("thinkingStrength" in explicit, false);
    assert.equal("basicModel" in blank, false);
  });

  await t.test("drops the task snapshot after the existing override is consumed", () => {
    let pendingOverride: ScheduledTaskRunOptions | null = {
      model: "task-model",
      basicModel: "task-basic",
    };
    const scheduledOptions = resolveAutoSendOptions({
      autoSendOverride: pendingOverride,
      apiConfigs,
      selectedModel: "manual-model",
      selectedApiProfile: "Profile A",
    });

    // Mirrors onAutoSendOverrideConsumed clearing the sole pending override.
    pendingOverride = null;
    const nextSendOptions = resolveAutoSendOptions({
      autoSendOverride: pendingOverride,
      apiConfigs,
      selectedModel: "manual-model",
      selectedApiProfile: "Profile A",
    });

    assert.equal(scheduledOptions.basicModel, "task-basic");
    assert.equal(nextSendOptions.model, "manual-model");
    assert.equal("basicModel" in nextSendOptions, false);
  });
});
