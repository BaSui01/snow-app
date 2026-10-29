import { ImageUp, RotateCcw } from "lucide-react";
import { useI18n } from "../../../i18n";
import { ChatImAvatar } from "../../mainContent/chatMessages/components/ChatImAvatar";
import type { ThemeChatStyle } from "./types";

export type ChatAvatarRole = "ai" | "user";

type ThemeChatStyleSectionProps = {
  chatStyle: ThemeChatStyle;
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
  onSelectAvatar: (role: ChatAvatarRole) => Promise<void>;
  onResetAvatar: (role: ChatAvatarRole) => Promise<void>;
};

export function ThemeChatStyleSection({
  chatStyle,
  disabled,
  onToggle,
  onSelectAvatar,
  onResetAvatar,
}: ThemeChatStyleSectionProps): React.JSX.Element {
  const { t } = useI18n();

  const renderAvatarRow = (role: ChatAvatarRole): React.JSX.Element => {
    const path =
      role === "ai" ? chatStyle.aiAvatarPath : chatStyle.userAvatarPath;
    return (
      <div className="theme-chat-avatar-row">
        <ChatImAvatar
          role={role === "ai" ? "assistant" : "user"}
          path={path}
          className="theme-chat-avatar-preview"
        />
        <div className="theme-chat-avatar-meta">
          <span className="theme-chat-avatar-label">
            {role === "ai"
              ? t("settings.themeChatStyleAiAvatar", {
                  defaultValue: "AI avatar",
                })
              : t("settings.themeChatStyleUserAvatar", {
                  defaultValue: "My avatar",
                })}
          </span>
          <span className="theme-chat-avatar-hint">
            {path
              ? t("settings.themeChatStyleAvatarCustom", {
                  defaultValue: "Custom image",
                })
              : role === "ai"
                ? t("settings.themeChatStyleAiAvatarDefault", {
                    defaultValue: "Default: built-in pet",
                  })
                : t("settings.themeChatStyleUserAvatarDefault", {
                    defaultValue: "Default icon",
                  })}
          </span>
        </div>
        <div className="theme-background-actions">
          <button
            type="button"
            className="api-settings-form-btn secondary"
            onClick={() => void onSelectAvatar(role)}
            disabled={disabled}
          >
            <ImageUp size={15} strokeWidth={1.8} />
            <span>
              {t("settings.themeChatStyleChangeAvatar", {
                defaultValue: "Change",
              })}
            </span>
          </button>
          {path ? (
            <button
              type="button"
              className="api-settings-form-btn secondary"
              onClick={() => void onResetAvatar(role)}
              disabled={disabled}
            >
              <RotateCcw size={15} strokeWidth={1.8} />
              <span>
                {t("settings.themeChatStyleResetAvatar", {
                  defaultValue: "Use default",
                })}
              </span>
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {t("settings.themeChatStyleTitle", {
            defaultValue: "IM chat style",
          })}
        </strong>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={chatStyle.imMode}
            onChange={(event) => onToggle(event.target.checked)}
            disabled={disabled}
            hidden
          />
          <span className="toggle-slider" />
          <span>
            {chatStyle.imMode
              ? t("settings.enabled", { defaultValue: "Enabled" })
              : t("settings.disabled", { defaultValue: "Disabled" })}
          </span>
        </label>
      </div>
      <span className="settings-item-description">
        {t("settings.themeChatStyleInfo", {
          defaultValue:
            "Show avatars next to messages like an instant messenger. Avatars can be replaced with your own images.",
        })}
      </span>
      {chatStyle.imMode ? (
        <div className="theme-chat-avatar-list">
          {renderAvatarRow("ai")}
          {renderAvatarRow("user")}
        </div>
      ) : null}
    </div>
  );
}
