/** Ecrãs de entrada (login, código, escolha de empresa): um cartão ao centro. */
export default function LayoutEntrada({ children }: LayoutProps<"/">) {
  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <p className="mb-6 text-sm font-medium text-zinc-500">Plataforma Comunicações</p>
        {children}
      </div>
    </main>
  );
}
