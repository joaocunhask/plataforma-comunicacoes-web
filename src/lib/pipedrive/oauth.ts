// OAuth 2.0 da app do Pipedrive (Developer Hub) e o JWT do modal (Custom Modal Action).
// Port de PipedriveOAuthClient, PipedriveOAuthState, PipedriveJwtHandler e
// PipedriveOauthTokenRepository.
//
// Configuração (variáveis de ambiente), da app no Developer Hub:
//   PIPEDRIVE_CLIENT_ID, PIPEDRIVE_CLIENT_SECRET, PIPEDRIVE_CALLBACK_URL
//   PIPEDRIVE_TOKENS_KEY — 32 bytes em base64, cifra os tokens guardados (AES-256-GCM)
//
// O client_secret assina também o `state` (HS256) e é a chave com que o Pipedrive assina o
// JWT do modal. Trocar de app (outro client_secret) invalida os tokens e states antigos.
import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { jwtVerify, SignJWT, errors as joseErrors } from "jose";
import { db as dbPorOmissao, type Executor } from "@/db";
import { authVerificacoes, orgPipedriveOauthTokens } from "@/db/schema";

const AUTHORIZE_URL = process.env.PIPEDRIVE_AUTHORIZE_URL ?? "https://oauth.pipedrive.com/oauth/authorize";
const TOKEN_URL = process.env.PIPEDRIVE_TOKEN_URL ?? "https://oauth.pipedrive.com/oauth/token";
const STATE_MINUTOS = 10;

export class ErroOAuth extends Error {
  constructor(
    mensagem: string,
    readonly statusCode?: number,
  ) {
    super(mensagem);
    this.name = "ErroOAuth";
  }
}

export interface ConfigOAuth {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

/** null se a app não estiver configurada (ClientId/ClientSecret/CallbackUrl). */
export function configOAuth(): ConfigOAuth | null {
  const clientId = process.env.PIPEDRIVE_CLIENT_ID ?? "";
  const clientSecret = process.env.PIPEDRIVE_CLIENT_SECRET ?? "";
  const callbackUrl = process.env.PIPEDRIVE_CALLBACK_URL ?? "";
  return clientId && clientSecret && callbackUrl ? { clientId, clientSecret, callbackUrl } : null;
}

const chave = (segredo: string) => new TextEncoder().encode(segredo);

// ── JWT do modal ─────────────────────────────────────────────────────────────

export interface IdentidadeModal {
  pipedriveUserId: number;
  pipedriveCompanyId: number;
  pipedriveDealId: number | null;
}

/** O token vem na query (?token=, o iframe) ou em Authorization: Bearer (os pedidos do modal). */
export function tokenDoModal(pedido: Request): string | null {
  const qs = new URL(pedido.url).searchParams.get("token");
  if (qs && qs.trim()) return qs;
  const auth = pedido.headers.get("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
}

const primeiro = (p: Record<string, unknown>, ...nomes: string[]) => {
  for (const n of nomes) {
    const v = p[n];
    if ((typeof v === "string" && v) || typeof v === "number") return String(v);
  }
  return null;
};
const longo = (t: string | null) => (t !== null && /^-?\d+$/.test(t.trim()) && Number.isSafeInteger(Number(t)) ? Number(t) : null);

/**
 * Valida o JWT que o Pipedrive manda ao modal: HS256 com o client_secret, exp obrigatório,
 * 2 min de tolerância. Sem iss/aud (o Pipedrive não os manda). null se inválido.
 */
export async function validarJwtModal(token: string, cfg: ConfigOAuth): Promise<IdentidadeModal | null> {
  try {
    const { payload } = await jwtVerify(token, chave(cfg.clientSecret), { algorithms: ["HS256"], clockTolerance: 120, requiredClaims: ["exp"] });
    const p = payload as Record<string, unknown>;
    const userId = longo(primeiro(p, "user_id", "userId", "sub"));
    const companyId = longo(primeiro(p, "company_id", "companyId"));
    if (userId === null || companyId === null) return null;
    return { pipedriveUserId: userId, pipedriveCompanyId: companyId, pipedriveDealId: longo(primeiro(p, "deal_id", "dealId")) };
  } catch (e) {
    if (e instanceof joseErrors.JOSEError || e instanceof TypeError) return null;
    throw e;
  }
}

// ── state (CSRF do fluxo a partir do modal) ──────────────────────────────────

export async function assinarState(cfg: ConfigOAuth, pipedriveUserId: number, pipedriveCompanyId: number): Promise<string> {
  const agora = Math.floor(Date.now() / 1000);
  return new SignJWT({ pu: String(pipedriveUserId), pc: String(pipedriveCompanyId) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setJti(randomUUID().replace(/-/g, ""))
    .setIssuedAt(agora)
    .setNotBefore(agora)
    .setExpirationTime(agora + STATE_MINUTOS * 60)
    .sign(chave(cfg.clientSecret));
}

export async function validarState(
  state: string,
  cfg: ConfigOAuth,
): Promise<{ pipedriveUserId: number; pipedriveCompanyId: number; jti: string } | null> {
  try {
    const { payload } = await jwtVerify(state, chave(cfg.clientSecret), { algorithms: ["HS256"], clockTolerance: 30, requiredClaims: ["exp"] });
    const u = longo(typeof payload.pu === "string" ? payload.pu : null);
    const c = longo(typeof payload.pc === "string" ? payload.pc : null);
    return u !== null && c !== null && payload.jti ? { pipedriveUserId: u, pipedriveCompanyId: c, jti: payload.jti } : null;
  } catch (e) {
    if (e instanceof joseErrors.JOSEError || e instanceof TypeError) return null;
    throw e;
  }
}

/**
 * Marca o jti como usado. false se já tinha sido (replay). Fica em auth_verificacoes, para
 * valer entre instâncias (o C# usava a cache em memória de um processo só).
 */
export async function consumirJti(jti: string, db: Executor = dbPorOmissao): Promise<boolean> {
  const inseridos = await db
    .insert(authVerificacoes)
    .values({
      id: `pd-oauth-jti:${jti}`,
      identifier: "pd-oauth-jti",
      value: jti,
      expiresAt: new Date(Date.now() + (STATE_MINUTOS + 1) * 60_000),
    })
    .onConflictDoNothing()
    .returning({ id: authVerificacoes.id });
  return inseridos.length === 1;
}

export function urlDeAutorizacao(cfg: ConfigOAuth, state: string | null): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.callbackUrl);
  if (state) u.searchParams.set("state", state);
  return u.toString();
}

// ── Troca e refresh de tokens ────────────────────────────────────────────────

export interface TokensOAuth {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresInSeconds: number;
  apiDomain: string;
}

async function pedirTokens(cfg: ConfigOAuth, form: Record<string, string>, op: string): Promise<TokensOAuth> {
  let r: Response;
  try {
    r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    throw new ErroOAuth(timeout ? "Timeout ao contactar oauth.pipedrive.com." : "Falha de rede ao contactar oauth.pipedrive.com.");
  }
  const corpo = await r.text();
  if (!r.ok) {
    console.warn(`Pipedrive OAuth ${op} respondeu ${r.status}: ${corpo.slice(0, 500)}`);
    throw new ErroOAuth(`Pipedrive OAuth ${op} devolveu ${r.status}.`, r.status);
  }
  const j = JSON.parse(corpo) as Record<string, unknown>;
  if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string")
    throw new ErroOAuth(`Pipedrive OAuth ${op}: resposta sem tokens.`);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    scope: typeof j.scope === "string" ? j.scope : "",
    expiresInSeconds: typeof j.expires_in === "number" ? j.expires_in : 3600,
    apiDomain: typeof j.api_domain === "string" ? j.api_domain : "",
  };
}

export const trocarCode = (cfg: ConfigOAuth, code: string) =>
  pedirTokens(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.callbackUrl }, "exchange_code");

export const renovarTokens = (cfg: ConfigOAuth, refreshToken: string) =>
  pedirTokens(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, "refresh");

// ── Tokens guardados (cifrados) ──────────────────────────────────────────────
// Formato: 0x01 | iv (12) | tag (16) | texto cifrado. Os tokens migrados do .NET estão
// cifrados com o Data Protection (outro formato, outra chave): não se decifram, e a linha
// passa a revogada — o comercial volta a ligar o Pipedrive uma vez.

const VERSAO = 0x01;

function chaveTokens(): Buffer {
  const k = Buffer.from(process.env.PIPEDRIVE_TOKENS_KEY ?? "", "base64");
  if (k.length !== 32) throw new Error("PIPEDRIVE_TOKENS_KEY tem de ser 32 bytes em base64 (openssl rand -base64 32).");
  return k;
}

export function cifrar(texto: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chaveTokens(), iv);
  const dados = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([VERSAO]), iv, c.getAuthTag(), dados]);
}

/** null se não for do formato atual ou não decifrar (ex.: tokens do Data Protection do .NET). */
export function decifrar(cifrado: Buffer): string | null {
  if (cifrado.length < 1 + 12 + 16 || cifrado[0] !== VERSAO) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", chaveTokens(), cifrado.subarray(1, 13));
    d.setAuthTag(cifrado.subarray(13, 29));
    return Buffer.concat([d.update(cifrado.subarray(29)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const ativo = (empresaId: number, pipedriveUserId: number) =>
  and(
    eq(orgPipedriveOauthTokens.empresaId, empresaId),
    eq(orgPipedriveOauthTokens.pipedriveUserId, pipedriveUserId),
    isNull(orgPipedriveOauthTokens.revogadoEm),
  );

export interface TokenValido {
  accessToken: string;
  apiDomain: string;
  expiresAt: Date;
}

/**
 * O access token válido de um utilizador Pipedrive, renovado se faltar menos de 60 s.
 * Se o refresh for recusado (400/401) ou o token não decifrar, revoga a linha e devolve null.
 */
export async function tokenValido(
  cfg: ConfigOAuth,
  empresaId: number,
  pipedriveUserId: number,
  db: Executor = dbPorOmissao,
): Promise<TokenValido | null> {
  const [linha] = await db.select().from(orgPipedriveOauthTokens).where(ativo(empresaId, pipedriveUserId)).limit(1);
  if (!linha) return null;
  const revogar = async (motivo: string) => {
    console.warn(`OAuth Pipedrive: ${motivo} (empresa=${empresaId} pipedrive_user=${pipedriveUserId}) — marcando revogado.`);
    await db.update(orgPipedriveOauthTokens).set({ revogadoEm: new Date() }).where(eq(orgPipedriveOauthTokens.id, linha.id));
    return null;
  };

  if (linha.expiresAt.getTime() > Date.now() + 60_000) {
    const access = decifrar(linha.accessTokenCiphertext);
    return access === null ? revogar("token não decifra") : { accessToken: access, apiDomain: linha.apiDomain, expiresAt: linha.expiresAt };
  }

  const refresh = decifrar(linha.refreshTokenCiphertext);
  if (refresh === null) return revogar("refresh token não decifra");
  let novos: TokensOAuth;
  try {
    novos = await renovarTokens(cfg, refresh);
  } catch (e) {
    if (e instanceof ErroOAuth && (e.statusCode === 400 || e.statusCode === 401)) return revogar("refresh recusado");
    throw e;
  }
  const expiresAt = new Date(Date.now() + novos.expiresInSeconds * 1000);
  await db
    .update(orgPipedriveOauthTokens)
    .set({
      accessTokenCiphertext: cifrar(novos.accessToken),
      refreshTokenCiphertext: cifrar(novos.refreshToken),
      expiresAt,
      apiDomain: novos.apiDomain,
      scope: novos.scope,
      atualizadoEm: new Date(),
    })
    .where(eq(orgPipedriveOauthTokens.id, linha.id));
  return { accessToken: novos.accessToken, apiDomain: novos.apiDomain, expiresAt };
}

/** Grava (ou renova) os tokens de um utilizador; uma linha ativa por (empresa, utilizador Pipedrive). */
export async function guardarTokens(
  params: { empresaId: number; pipedriveUserId: number; pipedriveCompanyId: number; aspnetUserId: string | null; tokens: TokensOAuth },
  db: Executor = dbPorOmissao,
): Promise<void> {
  const { empresaId, pipedriveUserId, tokens } = params;
  const valores = {
    aspnetUserId: params.aspnetUserId,
    accessTokenCiphertext: cifrar(tokens.accessToken),
    refreshTokenCiphertext: cifrar(tokens.refreshToken),
    apiDomain: tokens.apiDomain,
    scope: tokens.scope,
    expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
    atualizadoEm: new Date(),
  };
  await db.transaction(async (tx) => {
    const [linha] = await tx
      .select({ id: orgPipedriveOauthTokens.id })
      .from(orgPipedriveOauthTokens)
      .where(ativo(empresaId, pipedriveUserId))
      .for("update");
    if (linha) await tx.update(orgPipedriveOauthTokens).set(valores).where(eq(orgPipedriveOauthTokens.id, linha.id));
    else
      await tx
        .insert(orgPipedriveOauthTokens)
        .values({ ...valores, empresaId, pipedriveUserId, pipedriveCompanyId: params.pipedriveCompanyId, criadoEm: new Date() });
  });
}
