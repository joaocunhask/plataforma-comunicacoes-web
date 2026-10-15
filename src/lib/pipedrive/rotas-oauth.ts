// Handlers HTTP do OAuth do Pipedrive. Port de PipedriveEndpoints (OAuthStatus, OAuthStart,
// OAuthExchange) e da página UI/Components/Pages/Pipedrive/OAuthCallback.razor.
//
//   GET  /pipedrive/oauth/status   (JWT do modal) → { hasToken, empresaRegistrada }
//   GET  /pipedrive/oauth/start    (JWT do modal) → { authorizeUrl }
//   POST /pipedrive/oauth/exchange { code, state? } → { ok }
//   GET  /oauth/pipedrive/callback ?code&state     → página que faz a troca e avisa o modal
import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { orgEmpresas, orgMembros } from "@/db/schema";
import { ErroPipedrive, utilizadorAtual } from "./cliente";
import {
  assinarState,
  configOAuth,
  consumirJti,
  ErroOAuth,
  guardarTokens,
  tokenDoModal,
  tokenValido,
  trocarCode,
  urlDeAutorizacao,
  validarJwtModal,
  validarState,
  type ConfigOAuth,
  type IdentidadeModal,
} from "./oauth";
import { problema } from "./rotas-webhook";

const naoConfigurado = () => problema("Pipedrive OAuth não configurado (ClientId/ClientSecret/CallbackUrl).", 500);

async function empresaDaConta(pipedriveCompanyId: number): Promise<number | null> {
  const [e] = await db
    .select({ id: orgEmpresas.id })
    .from(orgEmpresas)
    .where(and(eq(orgEmpresas.pipedriveCompanyId, pipedriveCompanyId), eq(orgEmpresas.ativo, true)))
    .limit(1);
  return e?.id ?? null;
}

/** Autentica um pedido do modal pelo JWT do Pipedrive; Response 401 se falhar. */
export async function autenticarModal(pedido: Request): Promise<{ cfg: ConfigOAuth; id: IdentidadeModal } | Response> {
  const cfg = configOAuth();
  if (!cfg) {
    console.warn("PipedriveJwt: ClientSecret não configurado — rejeitando request.");
    return new Response(null, { status: 401 });
  }
  const token = tokenDoModal(pedido);
  const id = token ? await validarJwtModal(token, cfg) : null;
  return id ? { cfg, id } : new Response(null, { status: 401 });
}

export async function oauthStatus(pedido: Request): Promise<Response> {
  const auth = await autenticarModal(pedido);
  if (auth instanceof Response) return auth;
  const empresaId = await empresaDaConta(auth.id.pipedriveCompanyId);
  if (empresaId === null) return Response.json({ hasToken: false, empresaRegistrada: false });
  const token = await tokenValido(auth.cfg, empresaId, auth.id.pipedriveUserId);
  return Response.json({ hasToken: token !== null, empresaRegistrada: true });
}

export async function oauthStart(pedido: Request): Promise<Response> {
  const auth = await autenticarModal(pedido);
  if (auth instanceof Response) return auth;
  const state = await assinarState(auth.cfg, auth.id.pipedriveUserId, auth.id.pipedriveCompanyId);
  return Response.json({ authorizeUrl: urlDeAutorizacao(auth.cfg, state) });
}

type ResultadoTroca = { ok: true } | { ok: false; status: number; erro: string };

/**
 * Troca o code por tokens e grava-os. A identidade vem do /users/me com o token novo, não
 * do cliente. Com state (re-autorização a partir do modal): assinatura, uso único e tem de
 * ser a mesma conta que autorizou. Sem state (instalação a partir do Pipedrive) é legítimo.
 */
export async function trocar(code: string | null, state: string | null): Promise<ResultadoTroca> {
  const cfg = configOAuth();
  if (!cfg) return { ok: false, status: 500, erro: "Pipedrive OAuth não configurado (ClientId/ClientSecret/CallbackUrl)." };
  if (!code) return { ok: false, status: 400, erro: "code obrigatório." };

  let tokens;
  try {
    tokens = await trocarCode(cfg, code);
  } catch (e) {
    if (!(e instanceof ErroOAuth)) throw e;
    console.warn("OAuth exchange falhou.", e.message);
    return { ok: false, status: 502, erro: `Autorização falhou: ${e.message}` };
  }

  let quem;
  try {
    quem = await utilizadorAtual(tokens.accessToken);
  } catch (e) {
    if (!(e instanceof ErroPipedrive)) throw e;
    console.warn("OAuth exchange: falha a verificar identidade via /users/me.", e.message);
    return { ok: false, status: 502, erro: "Não foi possível verificar a identidade da autorização." };
  }

  if (state) {
    const s = await validarState(state, cfg);
    if (!s) return { ok: false, status: 400, erro: "State inválido ou expirado." };
    if (!(await consumirJti(s.jti))) {
      console.warn(`OAuth exchange: state reutilizado (jti ${s.jti}) — rejeitado.`);
      return { ok: false, status: 400, erro: "State já utilizado." };
    }
    if (s.pipedriveUserId !== quem.id || s.pipedriveCompanyId !== quem.companyId) {
      console.warn(
        `OAuth exchange REJEITADO: state user=${s.pipedriveUserId} company=${s.pipedriveCompanyId}; autorizou user=${quem.id} company=${quem.companyId}.`,
      );
      return { ok: false, status: 403, erro: "A conta que autorizou não corresponde à conta que iniciou o pedido." };
    }
  }

  const empresaId = await empresaDaConta(quem.companyId);
  if (empresaId === null) {
    console.warn(`OAuth exchange: company_id ${quem.companyId} não mapeado a nenhuma empresa ativa.`);
    return {
      ok: false,
      status: 403,
      erro: "Empresa não registada na plataforma — configura o pipedrive_company_id da empresa no admin antes de instalar.",
    };
  }

  const [membro] = await db
    .select({ userId: orgMembros.aspnetUserId })
    .from(orgMembros)
    .where(and(eq(orgMembros.empresaId, empresaId), eq(orgMembros.idCrm, String(quem.id)), eq(orgMembros.bloqueado, false)))
    .orderBy(asc(orgMembros.id))
    .limit(1);

  await guardarTokens({ empresaId, pipedriveUserId: quem.id, pipedriveCompanyId: quem.companyId, aspnetUserId: membro?.userId ?? null, tokens });
  console.info(
    `OAuth autorizado (${state ? "modal" : "instalação"}): empresa=${empresaId} pipedrive_user=${quem.id} company=${quem.companyId} aspnet_user=${membro?.userId ?? "(none)"}.`,
  );
  return { ok: true };
}

export async function oauthExchange(pedido: Request): Promise<Response> {
  let corpo: Record<string, unknown> = {};
  try {
    corpo = ((await pedido.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* corpo inválido → sem code */
  }
  const texto = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (!configOAuth()) return naoConfigurado();
  const r = await trocar(texto(corpo.code), texto(corpo.state));
  if (r.ok) return Response.json({ ok: true });
  return r.status === 400 ? Response.json({ error: r.erro }, { status: 400 }) : problema(r.erro, r.status);
}

/** A página do callback: troca o code no servidor e avisa a janela que a abriu (o modal). */
export async function oauthCallback(pedido: Request): Promise<Response> {
  const q = new URL(pedido.url).searchParams;
  let ok = false;
  let erro: string | null = null;
  if (q.get("error")) erro = "Autorização recusada.";
  else if (!q.get("code")) erro = "Callback sem code.";
  else {
    try {
      const r = await trocar(q.get("code"), q.get("state"));
      ok = r.ok;
      if (!r.ok) erro = `Erro do servidor (${r.status}).`;
    } catch (e) {
      console.error("OAuth callback falhou.", e);
      erro = "Erro inesperado.";
    }
  }
  return new Response(paginaCallback(ok, erro), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function paginaCallback(ok: boolean, erro: string | null): string {
  const corpo = ok
    ? `<div class="icone ok">✓</div><div>Autorização concluída. Podes fechar esta janela.</div><p>O modal principal recarrega automaticamente.</p>`
    : `<div class="icone erro">✕</div><div>Falhou a autorização.</div>${erro ? `<p>${escapar(erro)}</p>` : ""}<p>Fecha esta janela e tenta outra vez a partir do Pipedrive.</p>`;
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar Pipedrive</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center;color:#1f2937}
.icone{font-size:32px}.ok{color:#16a34a}.erro{color:#ef4444}p{color:#6b7280;font-size:14px}</style></head>
<body><section>${corpo}</section>
<script>try{if(window.opener)window.opener.postMessage(${JSON.stringify(ok ? "pipedrive_authorized" : "pipedrive_auth_failed")},"*")}catch(e){}
${ok ? "setTimeout(function(){window.close()},1500);" : ""}</script></body></html>`;
}
