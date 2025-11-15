import * as React from "react";

interface TabsContextValue {
  value: string;
  setValue: (v: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

export const Tabs: React.FC<{
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  className?: string;
}> = ({ value, defaultValue, onValueChange, className = "", children }) => {
  const [internal, setInternal] = React.useState<string>(defaultValue || "");
  const controlled = value !== undefined;
  const current = controlled ? value! : internal;

  const setValue = (v: string) => {
    if (!controlled) setInternal(v);
    onValueChange && onValueChange(v);
  };

  return (
    <TabsContext.Provider value={{ value: current, setValue }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
};

export const TabsList: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className = "",
  ...props
}) => (
  <div
    className={
      "inline-flex items-center rounded-2xl bg-slate-100 p-1 text-slate-600 dark:bg-slate-900 dark:text-slate-300 " +
      className
    }
    {...props}
  />
);

export const TabsTrigger: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }
> = ({ className = "", value, children, ...props }) => {
  const ctx = React.useContext(TabsContext);
  if (!ctx) return null;
  const active = ctx.value === value;
  return (
    <button
      type="button"
      onClick={() => ctx.setValue(value)}
      className={
        "px-3 py-1 text-xs rounded-xl transition-colors " +
        (active
          ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-50"
          : "text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800/60") +
        " " +
        className
      }
      {...props}
    >
      {children}
    </button>
  );
};

export const TabsContent: React.FC<{ value: string; className?: string }> = ({
  value,
  className = "",
  children
}) => {
  const ctx = React.useContext(TabsContext);
  if (!ctx || ctx.value !== value) return null;
  return <div className={className}>{children}</div>;
};
