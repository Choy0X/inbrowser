/** A compact on/off switch. Uses flex layout (no absolute positioning) so the
 *  knob always sits inside the track; off-state is a translucent gray so it
 *  reads clearly in both light and dark themes. The knob is a token, not raw
 *  white, so it stays visible on skins whose accent is itself light. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onChange(!checked);
      }}
      className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors !min-h-0 ${
        checked ? "bg-accent" : "bg-fg/15"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <span
        className={`h-5 w-5 rounded-full bg-bg-elevated shadow-soft transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}
