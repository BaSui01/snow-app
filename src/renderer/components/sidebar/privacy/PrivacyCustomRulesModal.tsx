import { useI18n } from "../../../i18n";
import { Modal } from "../../common/Modal";
import { FileViewerContent } from "../../rightPanel/FileViewerContent";
import type { PrivacyCustomRule } from "../../../../preload";

const EDITOR_FILE_NAME = "privacy-custom-rules.json";

// 空规则时给出示例，帮助用户理解格式
const TEMPLATE_RULES = [
  {
    name: "Internal domain",
    pattern: "(?i)\\b[a-z0-9-]+\\.corp\\.example\\.com\\b",
    group: 0,
    replacement: "",
    enabled: true,
  },
];

type PrivacyCustomRulesModalProps = {
  rules: PrivacyCustomRule[];
  onClose: () => void;
  onSaved: (rules: PrivacyCustomRule[]) => void;
};

/** 自定义脱敏规则 JSON 编辑弹窗：复用 FileViewerContent 的虚拟文件编辑。 */
export function PrivacyCustomRulesModal({
  rules,
  onClose,
  onSaved,
}: PrivacyCustomRulesModalProps): React.JSX.Element {
  const { t } = useI18n();
  const content = `${JSON.stringify(
    rules.length > 0 ? rules : TEMPLATE_RULES,
    null,
    2,
  )}\n`;

  return (
    <Modal
      open
      title={t("settings.privacyCustomEditorTitle", {
        defaultValue: "Edit custom masking rules",
      })}
      description={t("settings.privacyCustomEditorHint", {
        defaultValue:
          "JSON array. Fields: name, pattern (Rust regex, (?i) for case-insensitive), group (capture group to mask, 0 = whole match), replacement (empty = mask with *), enabled.",
      })}
      closeLabel={t("common.close", { defaultValue: "Close" })}
      onClose={onClose}
      size="large"
      className="file-edit-modal"
    >
      <FileViewerContent
        filePath={EDITOR_FILE_NAME}
        fileName={EDITOR_FILE_NAME}
        isSsh={false}
        initialEditMode
        virtualSource={{
          content,
          onSave: async (next) => {
            const saved = await window.snow.savePrivacyCustomRules(next);
            onSaved(saved);
          },
        }}
      />
    </Modal>
  );
}
