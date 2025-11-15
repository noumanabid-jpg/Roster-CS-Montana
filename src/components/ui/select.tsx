import * as React from "react";

interface SelectContextValue {
  value: string | undefined;
  setValue: (v: string) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
}

const SelectContext = React.createContext<SelectContextValue | null>(null);

export const Select: React.FC<{
  value?: string;
  onValueChange?: (v: string) => void;
  defaultValue?: string;
  children: React.ReactNode;
}> = ({ value, onValueChange, defaultValue, children }) => {
  const [internal, setInternal] = React.useState<string | undefined>(defaultValue);
  const [open, setOpen] = React.useState(false);
  const controlled = value !== undefined;
  const current = controlled ? value : internal;

  const setValue = (v: string) => {
    if (!controlled) setInternal(v);
    onValueChange && onValueChange(v);
    setOpen(false);
  };

  return (
    <SelectContext.Provider value={{ value: current, setValue, open, setOpen }}>
      {children}
    </SelectContext.Provider>
  );
};

export const SelectTrigger: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({
  className = "",
  children,
  ...props
}) => {
  const ctx = React.useContext(SelectContext);
  if (!ctx) return null;
  return (
    <button
      type="button"
      onClick={() => ctx.setOpen(!ctx.open)}
      className={
        "flex h-9 w-full items-center justify-between rounded-xl border border-slate-300 bg-white px-3 py-1 text-sm shadow-sm " +
        "dark:border-slate-700 dark:bg-slate-900 " +
        className
      }
      {...props}
    >
      {children}
    </button>
  );
};

export const SelectValue: React.FC<{ placeholder?: string }> = ({ placeholder }) => {
  const ctx = React.useContext(SelectContext);
  if (!ctx) return null;
  return (
    <span className="truncate text-left text-sm">
      {ctx.value || placeholder || "Select"}
    </span>
  );
};

export const SelectContent: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const ctx = React.useContext(SelectContext);
  if (!ctx || !ctx.open) return null;
  return (
    <div className="relative z-50 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
      {children}
    </div>
  );
};

export const SelectItem: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }
> = ({ value, className = "", children, ...props }) => {
  const ctx = React.useContext(SelectContext);
  if (!ctx) return null;
  const active = ctx.value === value;
  return (
    <button
      type="button"
      onClick={() => ctx.setValue(value)}
      className={
        "flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 " +
        (active ? "bg-slate-100 dark:bg-slate-800" : "") +
        " " +
        className
      }
      {...props}
    >
      {children}
    </button>
  );
};
