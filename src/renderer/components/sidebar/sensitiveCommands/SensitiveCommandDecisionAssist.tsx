import { BrainCircuit, ShieldCheck } from "lucide-react";
import {
  enabledDecisionModels,
  findDecisionModel,
  type DecisionModelConfig,
} from "../../../constants/decisionModels";
import type { SensitiveCommandAssistSettings } from "../../../constants/sensitiveCommandAssist";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";

type SensitiveCommandDecisionAssistProps = {
  settings: SensitiveCommandAssistSettings;
  /** 全局决策模型配置：这里只做选择，配置本身在「API 配置 → 决策模型」中维护。 */
  decisionModels: DecisionModelConfig[];
  isBusy: boolean;
  onChange: (next: SensitiveCommandAssistSettings) => void;
};

/**
 * 敏感命令面板的决策模型辅助设置（全局，与全局/项目标签页无关，始终显示）。
 *
 * - 辅助开关：默认关闭。关闭时不请求决策模型，敏感命令照常弹确认提示。
 * - 决策模型：判定用的模型，只能从已启用的决策模型中选择。
 * - 托管开关：默认关闭。开启后判定直接生效（允许则放行、拒绝则拒绝）；
 *   关闭时判定只在拦截提示中作为建议展示，是否执行仍由用户决定。
 */
export function SensitiveCommandDecisionAssist({
  settings,
  decisionModels,
  isBusy,
  onChange,
}: SensitiveCommandDecisionAssistProps): React.JSX.Element {
  const { t } = useI18n();

  // 只能选用已启用的决策模型；已选模型被停用/删除时保留一个提示项，避免选择被静默改掉。
  const enabledModels = enabledDecisionModels(decisionModels);
  const isSelectionAvailable = enabledModels.some(
    (model) => model.id === settings.modelId,
  );
  const unavailableSelection =
    settings.modelId !== "" && !isSelectionAvailable
      ? findDecisionModel(decisionModels, settings.modelId)
      : null;
  const modelOptions = [
    {
      value: "",
      label: t("settings.sensitiveCommandAssistModelNone", {
        defaultValue: "Not selected",
      }),
    },
    ...enabledModels.map((model) => ({ value: model.id, label: model.name })),
    ...(unavailableSelection
      ? [
          {
            value: settings.modelId,
            label: `${unavailableSelection.name} · ${t(
              "settings.sensitiveCommandAssistModelUnavailable",
              { defaultValue: "Unavailable" },
            )}`,
          },
        ]
      : []),
  ];
  const selectedModel = findDecisionModel(decisionModels, settings.modelId);
  const isModelUnavailable = settings.modelId !== "" && !isSelectionAvailable;
  const isActive = settings.enabled && settings.modelId !== "";

  return (
    <section
      className={`sensitive-command-assist${isActive ? " is-active" : ""}`}
      aria-label={t("settings.sensitiveCommandAssistTitle", {
        defaultValue: "Decision model assist",
      })}
    >
      <div className="sensitive-command-assist-header">
        <span className="sensitive-command-assist-icon" aria-hidden="true">
          <BrainCircuit size={14} strokeWidth={1.8} />
        </span>
        <div className="sensitive-command-assist-copy">
          <strong>
            {t("settings.sensitiveCommandAssistTitle", {
              defaultValue: "Decision model assist",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.sensitiveCommandAssistInfo", {
              defaultValue:
                "Let a decision model judge a command that matched a sensitive rule before the confirmation prompt shows up.",
            })}
          </span>
        </div>
      </div>

      <div className="sensitive-command-assist-rows">
        <label className="sensitive-command-assist-row">
          <span className="sensitive-command-assist-row-copy">
            <strong>
              {t("settings.sensitiveCommandAssistToggle", {
                defaultValue: "Enable decision model assist",
              })}
            </strong>
            <small>
              {t("settings.sensitiveCommandAssistToggleInfo", {
                defaultValue:
                  "Off by default. While off, sensitive commands keep the plain confirmation prompt.",
              })}
            </small>
          </span>
          <span className="toggle-switch">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={isBusy}
              aria-label={t("settings.sensitiveCommandAssistToggle", {
                defaultValue: "Enable decision model assist",
              })}
              onChange={(event) =>
                onChange({
                  ...settings,
                  enabled: event.target.checked,
                  // 辅助关闭后托管不再有意义，一并关闭以免留下悬空状态。
                  delegate: event.target.checked ? settings.delegate : false,
                })
              }
            />
            <span className="toggle-slider" aria-hidden="true" />
          </span>
        </label>

        <label className="sensitive-command-assist-row">
          <span className="sensitive-command-assist-row-copy">
            <strong>
              {t("settings.sensitiveCommandAssistModel", {
                defaultValue: "Decision model",
              })}
            </strong>
            <small>
              {enabledModels.length === 0
                ? t("settings.sensitiveCommandAssistModelEmpty", {
                    defaultValue:
                      "No enabled decision model yet. Add one in API settings → Decision models first.",
                  })
                : t("settings.sensitiveCommandAssistModelInfo", {
                    defaultValue:
                      "Only enabled decision models can be selected here.",
                  })}
            </small>
          </span>
          <span className="sensitive-command-assist-control">
            <CustomSelect
              value={settings.modelId}
              options={modelOptions}
              onChange={(value) => onChange({ ...settings, modelId: value })}
              disabled={isBusy || !settings.enabled}
              title={selectedModel?.name ?? ""}
            />
          </span>
        </label>

        <label className="sensitive-command-assist-row">
          <span className="sensitive-command-assist-row-copy">
            <strong>
              {t("settings.sensitiveCommandAssistDelegate", {
                defaultValue: "Let the decision model handle the gate",
              })}
            </strong>
            <small>
              {t("settings.sensitiveCommandAssistDelegateInfo", {
                defaultValue:
                  "When on, an allow verdict runs the command directly and a deny verdict rejects it, without showing the prompt.",
              })}
            </small>
          </span>
          <span className="toggle-switch">
            <input
              type="checkbox"
              checked={settings.enabled && settings.delegate}
              disabled={isBusy || !settings.enabled || settings.modelId === ""}
              aria-label={t("settings.sensitiveCommandAssistDelegate", {
                defaultValue: "Let the decision model handle the gate",
              })}
              onChange={(event) =>
                onChange({ ...settings, delegate: event.target.checked })
              }
            />
            <span className="toggle-slider" aria-hidden="true" />
          </span>
        </label>
      </div>

      {isModelUnavailable ? (
        <span className="sensitive-command-assist-warning">
          <ShieldCheck size={13} strokeWidth={1.8} aria-hidden="true" />
          {t("settings.sensitiveCommandAssistModelUnavailableInfo", {
            defaultValue:
              "The selected decision model is disabled or deleted; the assist stays idle until another one is selected.",
          })}
        </span>
      ) : null}
    </section>
  );
}
