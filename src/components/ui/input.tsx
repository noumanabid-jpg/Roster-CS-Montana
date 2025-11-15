import * as React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = "", ...props },
  ref
) {
  return (
    <input
      ref={ref}
      className={
        "flex h-9 w-full rounded-xl border border-slate-300 bg-white px-3 py-1 text-sm " +
        "placeholder:text-slate-400 shadow-sm " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1 " +
        "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 " +
        "dark:focus-visible:ring-slate-100 " +
        className
      }
      {...props}
    />
  );
});
