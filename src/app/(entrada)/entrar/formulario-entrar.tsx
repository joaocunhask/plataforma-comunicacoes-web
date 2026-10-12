"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Botao, Campo, MensagemErro } from "@/components/campos";
import { authCliente, destinoDepoisDoLogin, type RespostaLogin } from "@/lib/auth/cliente";
import { mensagemDeErro } from "@/lib/auth/mensagens";

export function FormularioEntrar() {
  const router = useRouter();
  const [erro, setErro] = useState<string | null>(null);
  const [aEnviar, setAEnviar] = useState(false);

  async function entrar(dados: FormData) {
    setErro(null);
    setAEnviar(true);
    const { data, error } = await authCliente.signIn.email({
      email: String(dados.get("email") ?? "").trim(),
      password: String(dados.get("password") ?? ""),
    });
    setAEnviar(false);
    if (error) {
      setErro(mensagemDeErro(error));
      return;
    }
    const resposta = data as RespostaLogin;
    router.replace(resposta.twoFactorRedirect ? "/entrar/codigo" : destinoDepoisDoLogin(resposta));
    router.refresh();
  }

  return (
    <form action={entrar} className="space-y-4">
      <h1 className="text-xl font-semibold">Entrar</h1>
      <Campo rotulo="Email" name="email" type="email" autoComplete="username" required autoFocus />
      <Campo rotulo="Password" name="password" type="password" autoComplete="current-password" required />
      <MensagemErro>{erro}</MensagemErro>
      <Botao type="submit" disabled={aEnviar}>
        {aEnviar ? "A entrar…" : "Entrar"}
      </Botao>
    </form>
  );
}
