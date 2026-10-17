type RoleSwitchRowProps = {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
};

/** ROLE 规则编辑器中的开关行（加载全局规则、覆盖内置提示词等）。 */
export const RoleSwitchRow = ({
  title,
  description,
  checked,
  disabled,
  onChange,
}: RoleSwitchRowProps): React.JSX.Element => (
  <div className="personalization-inheritance-row">
    <div className="personalization-inheritance-copy">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
    <label className="toggle-switch">
      <input
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span className="toggle-slider" />
    </label>
  </div>
);
