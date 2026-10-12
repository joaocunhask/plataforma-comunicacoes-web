"use client";

import { createAuthClient } from "better-auth/react";

/** Cliente do Better Auth no browser (mesma origem: /api/auth). */
export const authCliente = createAuthClient();

/** O corpo das respostas de login do plugin compat-identity. */
export interface RespostaLogin {
  twoFactorRedirect?: boolean;
  empresaAtivaId?: number | null;
  empresas?: { id: number; nome: string }[];
}

/** O destino depois de um login concluído. */
export function destinoDepoisDoLogin(resposta: RespostaLogin): string {
  return resposta.empresaAtivaId == null ? "/escolher-empresa" : "/";
}
