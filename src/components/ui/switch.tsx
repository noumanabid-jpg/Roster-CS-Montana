import * as React from "react";

export interface SwitchProps {
  checked?: boolean;
  onCheckedChange?: (value: boolean) => void;
}

export const Switch: React.FC<SwitchProps> = ({ checked = false, onCheckedChange }) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange && onCheckedChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors
        ${checked ? "bg-emerald-500 border-emerald-600" : "bg-slate-200 border-slate-300"}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
          ${checked ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
};
