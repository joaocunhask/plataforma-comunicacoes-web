import { eq } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { sair } from "@/app/acoes-sessao";
import { RenovarSessao } from "@/components/renovar-sessao";
import { db } from "@/db";
import { orgEmpresas } from "@/db/schema";
import { empresasDoUtilizador } from "@/lib/auth/repositorio";
import { exigirEmpresaAtiva } from "@/lib/auth/sessao";

const dataHora = (d: Date | string) => new Date(d).toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" });

async function DadosDaSessao() {
  const { user, session, empresaAtivaId } = await exigirEmpresaAtiva();
  const [[empresa], empresas] = await Promise.all([
    db.select({ nome: orgEmpresas.nome }).from(orgEmpresas).where(eq(orgEmpresas.id, empresaAtivaId)),
    empresasDoUtilizador(user.id),
  ]);

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border border-zinc-200 p-6 text-sm dark:border-zinc-800">
      <dt className="text-zinc-500">Utilizador</dt>
      <dd>{user.email}</dd>
      <dt className="text-zinc-500">Empresa</dt>
      <dd>
        {empresa?.nome}
        {empresas.length > 1 && (
          <Link href="/escolher-empresa" className="ml-3 text-zinc-500 hover:underline">
            trocar
          </Link>
        )}
      </dd>
      <dt className="text-zinc-500">Sessão iniciada</dt>
      <dd>{dataHora(session.createdAt)}</dd>
      <dt className="text-zinc-500">Expira sem atividade</dt>
      <dd>{dataHora(session.expiresAt)}</dd>
    </dl>
  );
}

/** Página inicial provisória da prova de conceito: mostra quem entrou e em que empresa. */
export default function PaginaInicial() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 space-y-6 px-4 py-12">
      <RenovarSessao />
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Plataforma Comunicações</h1>
        <form action={sair}>
          <button type="submit" className="text-sm text-zinc-500 hover:underline">
            Sair
          </button>
        </form>
      </header>
      <Suspense fallback={<p className="text-sm text-zinc-500">A carregar…</p>}>
        <DadosDaSessao />
      </Suspense>
    </main>
  );
}
