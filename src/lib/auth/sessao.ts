// Camada de acesso à sessão (o "DAL" do guia de autenticação do Next): é por aqui que as
// páginas, as server actions e os route handlers sabem quem é o utilizador e a empresa.
import "server-only";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { authSessoes } from "@/db/schema";
import { auth, SESSAO_MAXIMA_MS, type SessaoAuth } from "./servidor";

/** A sessão atual, ou null. Respeita o teto absoluto de 12 h (a sessão é apagada). */
export const obterSessao = cache(async (): Promise<SessaoAuth | null> => {
  const sessao = await auth.api.getSession({ headers: await headers() });
  if (!sessao) return null;
  if (Date.now() - new Date(sessao.session.createdAt).getTime() > SESSAO_MAXIMA_MS) {
    await db.delete(authSessoes).where(eq(authSessoes.id, sessao.session.id));
    return null;
  }
  return sessao;
});

/** Para páginas que exigem login: sem sessão, vai para /entrar. */
export async function exigirSessao(): Promise<SessaoAuth> {
  const sessao = await obterSessao();
  if (!sessao) redirect("/entrar");
  return sessao;
}

/** Para páginas da área de trabalho: exige também uma empresa ativa. */
export async function exigirEmpresaAtiva(): Promise<SessaoAuth & { empresaAtivaId: number }> {
  const sessao = await exigirSessao();
  const empresaAtivaId = sessao.session.empresaAtivaId;
  if (empresaAtivaId == null) redirect("/escolher-empresa");
  return { ...sessao, empresaAtivaId };
}
