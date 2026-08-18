import { useI18n } from "../../i18n";

/**
 * 绘图工作台示例提示词组件：渲染「试试这些」胶囊列表，
 * 点击通过 onPick 回调把示例填入提示词输入框。
 *
 * 独立成组件以便复用（空状态引导、参考图弹窗等场景）。
 */
export function DrawingPromptExamples({
  onPick,
}: {
  onPick: (prompt: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const exampleKeys = ["example1", "example2", "example3", "example4"];

  return (
    <div className="ai-drawing-examples">
      <span className="ai-drawing-examples-title">
        {t("rightPanel.aiDrawing.examplesTitle")}
      </span>
      {exampleKeys.map((key) => (
        <button
          type="button"
          className="ai-drawing-example-chip"
          key={key}
          onClick={() => onPick(t(`rightPanel.aiDrawing.${key}`))}
        >
          {t(`rightPanel.aiDrawing.${key}`)}
        </button>
      ))}
    </div>
  );
}
