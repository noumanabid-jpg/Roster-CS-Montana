import * as React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {}

export const Card: React.FC<CardProps> = ({ className = "", ...props }) => (
  <div
    className={
      "rounded-2xl border border-slate-200 bg-white/90 shadow-sm " +
      "dark:border-slate-800 dark:bg-slate-900/80 " +
      className
    }
    {...props}
  />
);

export const CardContent: React.FC<CardProps> = ({ className = "", ...props }) => (
  <div className={"p-4 " + className} {...props} />
);
