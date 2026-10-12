"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/servidor";

export async function sair() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/entrar");
}

export async function escolherEmpresa(dados: FormData) {
  const empresaId = Number(dados.get("empresaId"));
  // O endpoint confirma que o utilizador é membro ativo da empresa (senão lança 403).
  await auth.api.definirEmpresaAtiva({ body: { empresaId }, headers: await headers() });
  redirect("/");
}
