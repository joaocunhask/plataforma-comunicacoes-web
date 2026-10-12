// Better Auth: sessões em BD (auth_sessoes), passwords no formato do ASP.NET Identity e o
// fluxo de login da API .NET (plugin-identity.ts). O utilizador é o AspNetUsers.
import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/db";
import { aspNetUsers, authContas, authSessoes, authVerificacoes } from "@/db/schema";
import { hashPasswordIdentity, verificarPasswordIdentity } from "@/lib/identity";
import { compatibilidadeIdentity } from "./plugin-identity";

/** Sem atividade, a sessão acaba ao fim de 30 min (o access token da API .NET em produção). */
export const SESSAO_INATIVA_S = 30 * 60;
/** Teto absoluto desde o login, mesmo com atividade (Jwt:MaxSessionMinutes da API .NET). */
export const SESSAO_MAXIMA_MS = 12 * 60 * 60 * 1000;

export const auth = betterAuth({
  appName: "Plataforma Comunicações",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user: aspNetUsers, session: authSessoes, account: authContas, verification: authVerificacoes },
  }),
  user: {
    fields: { name: "userName", emailVerified: "emailConfirmed" },
  },
  session: {
    expiresIn: SESSAO_INATIVA_S,
    // Cada pedido com mais de 1 min desde a última renovação empurra a expiração (sliding).
    updateAge: 60,
    additionalFields: {
      empresaAtivaId: { type: "number", required: false, input: false },
    },
  },
  emailAndPassword: {
    enabled: true,
    // Só por convite, como hoje (o admin cria o utilizador).
    disableSignUp: true,
    // EmailConfirmed: a conta só entra depois de aceitar o convite.
    requireEmailVerification: true,
    minPasswordLength: 8,
    // O Identity não tinha máximo; não recusar passwords antigas compridas.
    maxPasswordLength: 1024,
    password: {
      hash: hashPasswordIdentity,
      verify: async ({ hash, password }) => (await verificarPasswordIdentity(hash, password)) !== "falhou",
    },
  },
  plugins: [compatibilidadeIdentity(), nextCookies()], // nextCookies tem de ser o último
});

export type SessaoAuth = typeof auth.$Infer.Session;
