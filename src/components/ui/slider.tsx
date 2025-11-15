import * as React from "react";

export interface SliderProps {
  value: [number];
  min?: number;
  max?: number;
  step?: number;
  onValueChange?: (value: [number]) => void;
}

export const Slider: React.FC<SliderProps> = ({
  value,
  min = 0,
  max = 100,
  step = 1,
  onValueChange
}) => {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value[0]}
      onChange={e => onValueChange && onValueChange([Number(e.target.value)])}
      className="w-full accent-slate-900"
    />
  );
};
