"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Botao, Campo, MensagemErro } from "@/components/campos";
import { authCliente, destinoDepoisDoLogin, type RespostaLogin } from "@/lib/auth/cliente";
import { mensagemDeErro } from "@/lib/auth/mensagens";

/** O código da aplicação autenticadora, depois da password. */
export default function PaginaCodigo() {
  const router = useRouter();
  const [erro, setErro] = useState<string | null>(null);
  const [aEnviar, setAEnviar] = useState(false);

  async function verificar(dados: FormData) {
    setErro(null);
    setAEnviar(true);
    const { data, error } = await authCliente.$fetch<RespostaLogin>("/compat-identity/2fa/verificar", {
      method: "POST",
      body: { codigo: String(dados.get("codigo") ?? "") },
    });
    setAEnviar(false);
    if (error) {
      setErro(mensagemDeErro(error));
      return;
    }
    router.replace(destinoDepoisDoLogin(data));
    router.refresh();
  }

  return (
    <form action={verificar} className="space-y-4">
      <h1 className="text-xl font-semibold">Código de verificação</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Introduza o código de 6 dígitos da aplicação autenticadora.</p>
      <Campo rotulo="Código" name="codigo" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
      <MensagemErro>{erro}</MensagemErro>
      <Botao type="submit" disabled={aEnviar}>
        {aEnviar ? "A verificar…" : "Verificar"}
      </Botao>
      <Link href="/entrar" className="block text-center text-sm text-zinc-500 hover:underline">
        Voltar ao início
      </Link>
    </form>
  );
}
