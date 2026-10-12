import type { ComponentProps } from "react";

/** Um campo de formulário com rótulo. */
export function Campo({ rotulo, ...props }: ComponentProps<"input"> & { rotulo: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">{rotulo}</span>
      <input
        className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-100 dark:focus:ring-zinc-100"
        {...props}
      />
    </label>
  );
}

export function Botao({ className = "", ...props }: ComponentProps<"button">) {
  return (
    <button
      className={`w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 ${className}`}
      {...props}
    />
  );
}

export function MensagemErro({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
      {children}
    </p>
  );
}
