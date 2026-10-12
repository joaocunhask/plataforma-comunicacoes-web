import { Suspense } from "react";
import { escolherEmpresa, sair } from "@/app/acoes-sessao";
import { empresasDoUtilizador } from "@/lib/auth/repositorio";
import { exigirSessao } from "@/lib/auth/sessao";

async function ListaDeEmpresas() {
  const { session } = await exigirSessao();
  const empresas = await empresasDoUtilizador(session.userId);
  return (
    <ul className="space-y-2">
      {empresas.map((e) => (
        <li key={e.id}>
          <form action={escolherEmpresa}>
            <input type="hidden" name="empresaId" value={e.id} />
            <button
              type="submit"
              className={`w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
                e.id === session.empresaAtivaId ? "border-zinc-900 dark:border-zinc-100" : "border-zinc-200 dark:border-zinc-700"
              }`}
            >
              {e.nome}
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}

export default function PaginaEscolherEmpresa() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Escolher empresa</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">A sua conta tem acesso a várias empresas.</p>
      <Suspense fallback={<p className="text-sm text-zinc-500">A carregar…</p>}>
        <ListaDeEmpresas />
      </Suspense>
      <form action={sair}>
        <button type="submit" className="w-full text-center text-sm text-zinc-500 hover:underline">
          Sair
        </button>
      </form>
    </div>
  );
}
