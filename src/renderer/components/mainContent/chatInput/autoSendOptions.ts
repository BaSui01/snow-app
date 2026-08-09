import type {
  ApiConfigRecord,
  ScheduledTaskRunOptions,
} from "../../../../preload";
import type { ChatInputSendOptions } from "./types";

type AutoSendApiConfig = Pick<
  ApiConfigRecord,
  "profileName" | "advancedModel"
>;

export type ResolveAutoSendOptionsInput = {
  autoSendOverride?: ScheduledTaskRunOptions | null;
  apiConfigs: readonly AutoSendApiConfig[];
  selectedModel?: string;
  selectedApiProfile?: string;
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

/**
 * Resolves the one-shot options used by buildFromContent auto-sends.
 * A task-bound profile may only use that same profile's advanced model; when
 * the profile is unavailable, the model stays omitted for Native fallback.
 */
export const resolveAutoSendOptions = ({
  autoSendOverride,
  apiConfigs,
  selectedModel,
  selectedApiProfile,
}: ResolveAutoSendOptionsInput): ChatInputSendOptions => {
  const taskApiProfile = nonEmpty(autoSendOverride?.apiProfile);
  const explicitTaskModel = nonEmpty(autoSendOverride?.model);
  let model = explicitTaskModel;

  if (!model) {
    if (taskApiProfile) {
      const taskApiConfig = apiConfigs.find(
        (config) => config.profileName.trim() === taskApiProfile
      );
      model = nonEmpty(taskApiConfig?.advancedModel);
    } else {
      model = nonEmpty(selectedModel);
    }
  }

  const apiProfile = taskApiProfile ?? nonEmpty(selectedApiProfile);
  const basicModel = nonEmpty(autoSendOverride?.basicModel);
  const thinkingStrength = nonEmpty(autoSendOverride?.thinkingStrength);
  const options: ChatInputSendOptions = {};

  if (model) options.model = model;
  if (apiProfile) options.apiProfile = apiProfile;
  if (basicModel) options.basicModel = basicModel;
  if (thinkingStrength) options.thinkingStrength = thinkingStrength;

  return options;
};
