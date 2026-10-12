import { redirect } from "next/navigation";
import { Suspense } from "react";
import { obterSessao } from "@/lib/auth/sessao";
import { FormularioEntrar } from "./formulario-entrar";

/** Quem já tem sessão não precisa do formulário. */
async function SairSeJaEntrou() {
  if (await obterSessao()) redirect("/");
  return null;
}

export default function PaginaEntrar() {
  return (
    <>
      <Suspense>
        <SairSeJaEntrou />
      </Suspense>
      <FormularioEntrar />
    </>
  );
}
