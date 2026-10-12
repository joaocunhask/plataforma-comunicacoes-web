// Plugin do Better Auth com o fluxo de login da API .NET (AuthService.LoginAsync /
// VerifyTotpAsync / EmitirLoginAsync), por esta ordem:
//
//   1. conta bloqueada?            → CONTA_BLOQUEADA (antes de ver a password)
//   2. password (Better Auth + src/lib/identity); errada → conta mais uma falha
//   3. password certa → limpa as falhas e regrava o hash se tiver parâmetros antigos
//   4. email por confirmar         → EMAIL_NOT_VERIFIED (do Better Auth)
//   5. 2FA ativo → não há sessão: fica um desafio (cookie assinado, 10 min) até ao código
//   6. empresa: nenhuma → SEM_EMPRESA; uma → fica ativa; várias → escolhe-se a seguir
//
// O passo 5 segue o plugin oficial two-factor do Better Auth, mas valida o código com o
// AuthenticatorTokenProvider do Identity (src/lib/identity/totp.ts): as chaves já
// configuradas continuam a valer, com a mesma janela. Ao contrário da API .NET, o código
// só é aceite depois da password (o /auth/totp/verify antigo aceitava email + código).

import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, isAPIError, sessionMiddleware } from "better-auth/api";
import { deleteSessionCookie, expireCookie, setSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import * as z from "zod";
import { estaBloqueado, validarCodigoAutenticador } from "@/lib/identity";
import {
  chaveDoAutenticador,
  empresasDoUtilizador,
  limparTentativasFalhadas,
  regravarPasswordSePreciso,
  registarTentativaFalhada,
  utilizadorPorEmail,
  utilizadorPorId,
} from "./repositorio";

const COOKIE_DESAFIO_2FA = "desafio_2fa";
const DURACAO_DESAFIO_2FA_S = 10 * 60;

export const ERROS_LOGIN = {
  CONTA_BLOQUEADA: "Conta bloqueada temporariamente por tentativas falhadas. Tente novamente mais tarde.",
  CODIGO_INVALIDO: "Código inválido.",
  DESAFIO_2FA_INVALIDO: "O pedido de código expirou. Volte a introduzir o email e a password.",
  SEM_EMPRESA: "Esta conta não tem acesso a nenhuma empresa ativa.",
  EMPRESA_INVALIDA: "Não tem acesso a essa empresa.",
} as const;

type CodigoErro = keyof typeof ERROS_LOGIN;
const erro = (status: "UNAUTHORIZED" | "FORBIDDEN", codigo: CodigoErro) =>
  new APIError(status, { code: codigo, message: ERROS_LOGIN[codigo] });

type Contexto = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * Último passo do login (EmitirLoginAsync): resolve a empresa. Sem empresas, desfaz a sessão.
 * Devolve o corpo da resposta.
 */
async function concluirLogin(ctx: Contexto, sessao: { token: string; userId: string }) {
  const empresas = await empresasDoUtilizador(sessao.userId);
  if (empresas.length === 0) {
    deleteSessionCookie(ctx, true);
    await ctx.context.internalAdapter.deleteSession(sessao.token);
    ctx.context.setNewSession(null);
    throw erro("FORBIDDEN", "SEM_EMPRESA");
  }
  const empresaAtivaId = empresas.length === 1 ? empresas[0].id : null;
  if (empresaAtivaId !== null) await ctx.context.internalAdapter.updateSession(sessao.token, { empresaAtivaId });
  return ctx.json({ empresaAtivaId, empresas });
}

export function compatibilidadeIdentity() {
  return {
    id: "compat-identity",
    hooks: {
      before: [
        {
          // 1. Bloqueado antes de ver a password, para não dar pistas nem tentativas.
          matcher: (ctx) => ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const email = typeof ctx.body?.email === "string" ? ctx.body.email : null;
            const utilizador = email ? await utilizadorPorEmail(email) : null;
            if (utilizador && estaBloqueado(utilizador)) throw erro("FORBIDDEN", "CONTA_BLOQUEADA");
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const email = typeof ctx.body?.email === "string" ? ctx.body.email : null;
            const password = typeof ctx.body?.password === "string" ? ctx.body.password : "";
            const resultado = ctx.context.returned;

            if (isAPIError(resultado)) {
              const codigo = (resultado.body as { code?: string } | undefined)?.code;
              const utilizador = email ? await utilizadorPorEmail(email) : null;
              if (!utilizador) return;
              // 2. Password errada (ou utilizador sem password) conta como falha.
              if (codigo === "INVALID_EMAIL_OR_PASSWORD") await registarTentativaFalhada(utilizador.id);
              // 4. A password estava certa; só falta a conta ser ativada.
              if (codigo === "EMAIL_NOT_VERIFIED") {
                await limparTentativasFalhadas(utilizador.id);
                await regravarPasswordSePreciso(utilizador.id, password);
              }
              return;
            }

            const nova = ctx.context.newSession;
            if (!nova) return;
            const userId = nova.user.id;

            // 3.
            await limparTentativasFalhadas(userId);
            await regravarPasswordSePreciso(userId, password);

            // 5. 2FA: a sessão criada pela password não serve; fica um desafio pendente.
            const utilizador = await utilizadorPorId(userId);
            if (utilizador?.twoFactorEnabled) {
              deleteSessionCookie(ctx, true);
              await ctx.context.internalAdapter.deleteSession(nova.session.token);
              ctx.context.setNewSession(null);

              const cookie = ctx.context.createAuthCookie(COOKIE_DESAFIO_2FA, { maxAge: DURACAO_DESAFIO_2FA_S });
              const identificador = `desafio-2fa-${generateRandomString(32)}`;
              await ctx.context.internalAdapter.createVerificationValue({
                identifier: identificador,
                value: userId,
                expiresAt: new Date(Date.now() + DURACAO_DESAFIO_2FA_S * 1000),
              });
              await ctx.setSignedCookie(cookie.name, identificador, ctx.context.secret, cookie.attributes);
              return ctx.json({ twoFactorRedirect: true });
            }

            // 6.
            return concluirLogin(ctx, { token: nova.session.token, userId });
          }),
        },
      ],
    },
    endpoints: {
      /** O código da aplicação autenticadora, depois da password (VerifyTotpAsync). */
      verificarCodigo2fa: createAuthEndpoint(
        "/compat-identity/2fa/verificar",
        { method: "POST", body: z.object({ codigo: z.string().max(32) }) },
        async (ctx) => {
          const cookie = ctx.context.createAuthCookie(COOKIE_DESAFIO_2FA);
          const identificador = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          const desafio = identificador ? await ctx.context.internalAdapter.findVerificationValue(identificador) : null;
          if (!identificador || !desafio || desafio.expiresAt < new Date()) throw erro("UNAUTHORIZED", "DESAFIO_2FA_INVALIDO");

          const utilizador = await utilizadorPorId(desafio.value);
          if (!utilizador) throw erro("UNAUTHORIZED", "DESAFIO_2FA_INVALIDO");
          if (estaBloqueado(utilizador)) throw erro("FORBIDDEN", "CONTA_BLOQUEADA");

          // Uma chave com caracteres inválidos lança (500), como no .NET.
          if (!validarCodigoAutenticador(await chaveDoAutenticador(utilizador.id), ctx.body.codigo)) {
            await registarTentativaFalhada(utilizador.id);
            throw erro("UNAUTHORIZED", "CODIGO_INVALIDO");
          }
          await limparTentativasFalhadas(utilizador.id);

          // O desafio só serve uma vez (dois pedidos em paralelo: só um passa).
          const consumido = await ctx.context.internalAdapter.consumeVerificationValue(identificador);
          if (!consumido || consumido.value !== utilizador.id) throw erro("UNAUTHORIZED", "DESAFIO_2FA_INVALIDO");
          expireCookie(ctx, cookie);

          const sessao = await ctx.context.internalAdapter.createSession(utilizador.id);
          const user = await ctx.context.internalAdapter.findUserById(utilizador.id);
          if (!sessao || !user) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Falha a criar a sessão." });
          await setSessionCookie(ctx, { session: sessao, user });
          return concluirLogin(ctx, { token: sessao.token, userId: utilizador.id });
        },
      ),

      /** As empresas a que o utilizador da sessão pode entrar, e a ativa. */
      empresas: createAuthEndpoint(
        "/compat-identity/empresas",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const { session } = ctx.context.session;
          return ctx.json({
            empresaAtivaId: (session as { empresaAtivaId?: number | null }).empresaAtivaId ?? null,
            empresas: await empresasDoUtilizador(session.userId),
          });
        },
      ),

      /** Troca a empresa ativa (SwitchEmpresaAsync); a sessão mantém o início, e o teto de 12 h. */
      definirEmpresaAtiva: createAuthEndpoint(
        "/compat-identity/empresa-ativa",
        { method: "POST", body: z.object({ empresaId: z.number().int() }), use: [sessionMiddleware] },
        async (ctx) => {
          const { session } = ctx.context.session;
          const empresas = await empresasDoUtilizador(session.userId);
          if (!empresas.some((e) => e.id === ctx.body.empresaId)) throw erro("FORBIDDEN", "EMPRESA_INVALIDA");
          await ctx.context.internalAdapter.updateSession(session.token, { empresaAtivaId: ctx.body.empresaId });
          return ctx.json({ empresaAtivaId: ctx.body.empresaId });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
