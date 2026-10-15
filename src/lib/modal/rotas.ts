// Os endpoints do modal do Pipedrive (Custom Modal Action), autenticados pelo JWT do modal.
// Port de API/Endpoints/PipedriveEndpoints.cs (Extract, Apply, CriarNegocio, Catalog, ExtendSession).
//
//   POST /pipedrive/contract/extract       texto colado → linhas resolvidas e classificadas
//   POST /pipedrive/contract/apply         grava id_simulador e acrescenta os produtos ao negócio
//   POST /pipedrive/contract/criar-negocio cria um negócio-irmão noutro funil, com os produtos
//   GET  /pipedrive/catalog                produtos com PPID, para o seletor manual
//   POST /pipedrive/session/extend         troca o JWT de ~5 min do Pipedrive por um de 30 min
//
// Leituras com o pipedrive_api_token da empresa (nem todos os comerciais têm permissão
// "Products"); escritas com o OAuth do comercial, para o histórico do negócio ficar em nome dele.
import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { db } from "@/db";
import { orgEmpresaPipedriveFieldMap, orgEmpresas, orgMembros, sysContratoUploads } from "@/db/schema";
import { NetDecimal } from "@/lib/calculo";
import { decimal, NumeroJson, parseJsonExato } from "@/lib/pipedrive/json-exato";
import {
  adicionarProdutoAoNegocio,
  campoComoTexto,
  criarNegocio,
  ErroPipedrive,
  idDeCampo,
  jsonComDecimais,
  obterCamposDeProduto,
  obterNegocio,
  obterTodosProdutos,
  procurarNegociosPorCampo,
  atualizarNegocio,
  type Credencial,
  type Registo,
} from "@/lib/pipedrive/cliente";
import { tokenValido, type ConfigOAuth, type IdentidadeModal } from "@/lib/pipedrive/oauth";
import { autenticarModal } from "@/lib/pipedrive/rotas-oauth";
import { problema } from "@/lib/pipedrive/rotas-webhook";
import { classificar, type ClassificacaoLinha, type ResultadoClassificacao } from "./classificacao";
import { ErroExtracao, extrairLinhas } from "./extrator";
import { ehPpidValido, resolverLinhas, type ProdutoCatalogo } from "./resolver";
import { expandir, observacoes } from "./subscricoes";

/** Proteção de custo: cada extract chama o Claude. Um contrato real não passa de ~3,6 KB. */
const MAX_TEXTO_BYTES = 8 * 1024;
/** Mínimo do motivo para incluir neste negócio uma linha de outro funil. */
const MOTIVO_MINIMO = 5;
const NOME_CAMPO_PPID = "Pricing Plan ID";
const SESSAO_MIN = 30;

const json = (corpo: unknown, status = 200) =>
  new Response(jsonComDecimais(corpo), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const erro400 = (mensagem: string) => json({ error: mensagem }, 400);
const autorizacaoNecessaria = () => json({ error: "authorization_required" }, 401);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// ── Contexto comum ───────────────────────────────────────────────────────────

interface Contexto {
  cfg: ConfigOAuth;
  id: IdentidadeModal;
  empresaId: number;
  leitura: Credencial;
}

/** JWT do modal + empresa da conta Pipedrive + api_token. Response se falhar. */
async function contexto(pedido: Request, semToken: string): Promise<Contexto | Response> {
  const auth = await autenticarModal(pedido);
  if (auth instanceof Response) return auth;
  const [empresa] = await db
    .select({ id: orgEmpresas.id, apiToken: orgEmpresas.pipedriveApiToken })
    .from(orgEmpresas)
    .where(and(eq(orgEmpresas.pipedriveCompanyId, auth.id.pipedriveCompanyId), eq(orgEmpresas.ativo, true)))
    .limit(1);
  if (!empresa) {
    console.info(`Modal: pipedrive_company_id ${auth.id.pipedriveCompanyId} não mapeado.`);
    return problema("Empresa não registada na plataforma.", 403);
  }
  if (!empresa.apiToken?.trim()) return problema(semToken, 500);
  return { ...auth, empresaId: empresa.id, leitura: { tipo: "api-token", token: empresa.apiToken } };
}

async function escritaOAuth(c: Contexto): Promise<Credencial | null> {
  const t = await tokenValido(c.cfg, c.empresaId, c.id.pipedriveUserId);
  return t && { tipo: "oauth", accessToken: t.accessToken };
}

async function campoDoMapa(empresaId: number, chave: string): Promise<string | null> {
  const [m] = await db
    .select({ key: orgEmpresaPipedriveFieldMap.pipedriveFieldKey })
    .from(orgEmpresaPipedriveFieldMap)
    .where(and(eq(orgEmpresaPipedriveFieldMap.empresaId, empresaId), eq(orgEmpresaPipedriveFieldMap.chaveLogica, chave)))
    .limit(1);
  return m?.key?.trim() ? m.key : null;
}

async function membroDoUtilizador(empresaId: number, pipedriveUserId: number): Promise<string | null> {
  const [m] = await db
    .select({ userId: orgMembros.aspnetUserId })
    .from(orgMembros)
    .where(and(eq(orgMembros.empresaId, empresaId), eq(orgMembros.idCrm, String(pipedriveUserId)), eq(orgMembros.bloqueado, false)))
    .orderBy(asc(orgMembros.id))
    .limit(1);
  return m?.userId ?? null;
}

// Caches por instância (o C# usava a IMemoryCache): best-effort, não são fonte de verdade.
const cache = new Map<string, { valor: unknown; ate: number }>();
function emCache<T>(chave: string): T | undefined {
  const e = cache.get(chave);
  if (e && e.ate > Date.now()) return e.valor as T;
  cache.delete(chave);
  return undefined;
}
const guardar = (chave: string, valor: unknown, ms: number) => cache.set(chave, { valor, ate: Date.now() + ms });

/** A key do campo "Pricing Plan ID": do mapa de campos; senão, descoberta por nome (1 h em cache). */
async function campoPpid(c: Contexto): Promise<string | null> {
  const doMapa = await campoDoMapa(c.empresaId, "pricing_plan_id");
  if (doMapa) return doMapa;
  const chave = `pd-ppid-field:${c.empresaId}`;
  const guardado = emCache<string>(chave);
  if (guardado) return guardado;
  const campos = await obterCamposDeProduto(c.leitura);
  const achado = campos.find((f) => f.nome.trim().toLowerCase() === NOME_CAMPO_PPID.toLowerCase());
  if (!achado) {
    console.warn(`Campo de produto '${NOME_CAMPO_PPID}' não encontrado (empresa ${c.empresaId}). Campos: ${campos.map((f) => `'${f.nome}'`).join(", ")}`);
    return null;
  }
  console.info(`PPID resolvido por nome (empresa ${c.empresaId}) — configura 'pricing_plan_id' no admin para tornar explícito.`);
  guardar(chave, achado.key, 3_600_000);
  return achado.key;
}

/** PPID → produto, lendo SÓ o campo do PPID (um MSISDN noutro campo não entra como PPID). */
function indicePorPpid(catalogo: readonly Registo[], key: string): Map<string, Registo> {
  const indice = new Map<string, Registo>();
  for (const p of catalogo) {
    const v = campoComoTexto(p, key)?.trim();
    if (ehPpidValido(v)) indice.set(v, p); // último ganha
  }
  return indice;
}

const erroCampoPpid = () => problema(`Campo de produto '${NOME_CAMPO_PPID}' não encontrado no Pipedrive desta conta.`, 500);

/** A classificação por funil, sem nunca fazer falhar o pedido (é uma ajuda). */
async function classificarSemFalhar(
  c: Contexto,
  dealId: number,
  ppids: readonly (string | null)[],
): Promise<{ resultado: ResultadoClassificacao; titulo: string | null }> {
  const vazio = (motivo: string) => ({ resultado: { ativa: false, motivoInativa: motivo, nomeObjetivoDoNegocio: null, porPpid: new Map() }, titulo: null });
  if (dealId <= 0) return vazio("Negócio não identificado.");
  try {
    const negocio = await obterNegocio(dealId, c.leitura);
    if (!negocio) return vazio("Negócio não encontrado no Pipedrive.");
    const titulo = typeof negocio.campos.title === "string" ? negocio.campos.title : null;
    return { resultado: await classificar(c.empresaId, idDeCampo(negocio, "pipeline_id"), ppids), titulo };
  } catch (e) {
    if (!(e instanceof ErroPipedrive)) throw e;
    console.warn(`Classificação de funil ignorada (empresa ${c.empresaId}, deal ${dealId}): falha a ler o negócio.`);
    return vazio("Não foi possível ler o funil do negócio.");
  }
}

const daLinha = (r: ResultadoClassificacao, ppid: string | null): ClassificacaoLinha | null =>
  !r.ativa || !ppid?.trim() ? null : (r.porPpid.get(ppid) ?? null);

// ── Pedidos ──────────────────────────────────────────────────────────────────

async function lerCorpo(pedido: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = parseJsonExato(await pedido.text());
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const int = (v: unknown): number => {
  const n = v instanceof NumeroJson ? Number(v.texto) : typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

interface LinhaAplicar {
  nomeProduto: string;
  quantidade: number;
  duracaoMeses: number;
  multaMensal: NetDecimal;
  pricingPlanId: string;
  pipedriveProductId: number | null;
  numerosAssociados: string[];
  motivoForaDoFunil: string | null;
}

function lerLinhas(v: unknown): LinhaAplicar[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    let multa = NetDecimal.ZERO;
    try {
      multa = decimal(o.multaMensal) ?? (typeof o.multaMensal === "string" ? NetDecimal.de(o.multaMensal) : NetDecimal.ZERO);
    } catch {
      /* inválida → 0, recusada abaixo */
    }
    const pid = int(o.pipedriveProductId);
    return {
      nomeProduto: str(o.nomeProduto) ?? "",
      quantidade: int(o.quantidade),
      duracaoMeses: int(o.duracaoMeses),
      multaMensal: multa,
      pricingPlanId: str(o.pricingPlanId) ?? "",
      pipedriveProductId: pid > 0 ? pid : null,
      numerosAssociados: Array.isArray(o.numerosAssociados) ? o.numerosAssociados.filter((n): n is string => typeof n === "string") : [],
      motivoForaDoFunil: str(o.motivoForaDoFunil),
    };
  });
}

/** As validações comuns ao Aplicar e ao Criar negócio. */
function validarLinhas(linhas: readonly LinhaAplicar[]): string | null {
  if (linhas.some((l) => l.pipedriveProductId === null)) return "Todas as linhas têm de ter pipedrive_product_id válido.";
  if (linhas.some((l) => l.quantidade <= 0)) return "Todas as linhas têm de ter quantidade positiva.";
  // Sem duração não há escalão; sem RLMC o upfront é zero: o motor descartava-as.
  if (linhas.some((l) => l.duracaoMeses <= 0)) return "Todas as linhas têm de ter duração de contrato.";
  if (linhas.some((l) => l.multaMensal.lte(0))) return "Todas as linhas têm de ter multa mensal (RLMC).";
  return null;
}

/** Revalida o PPID→produto contra o catálogo real (o cliente pode afirmar qualquer id). */
async function ppidsInvalidos(c: Contexto, linhas: readonly LinhaAplicar[]): Promise<string[] | Response> {
  const key = await campoPpid(c);
  if (!key) return erroCampoPpid();
  const indice = indicePorPpid(await obterTodosProdutos(c.leitura), key);
  return [...new Set(linhas.filter((l) => indice.get(l.pricingPlanId)?.id !== l.pipedriveProductId).map((l) => l.pricingPlanId))];
}

type Aplicado = { pricingPlanId: string; productId: number; quantity: number; dealProductId: number };
type ErroAplicar = { pricingPlanId: string; error: string };

/**
 * Agrupa por (PPID, duração, multa) e acrescenta cada grupo ao negócio, com as subscrições
 * nas observações. ACRESCENTA: chamar duas vezes duplica os produtos.
 */
async function adicionarProdutos(dealId: number, linhas: readonly LinhaAplicar[], cred: Credencial, empresaId: number) {
  const applied: Aplicado[] = [];
  const errors: ErroAplicar[] = [];
  const grupos = new Map<string, LinhaAplicar[]>();
  for (const l of linhas) {
    const k = JSON.stringify([l.pricingPlanId, l.duracaoMeses, l.multaMensal.toString()]);
    grupos.set(k, [...(grupos.get(k) ?? []), l]);
  }
  for (const grupo of grupos.values()) {
    const primeira = grupo[0];
    const subs = grupo.flatMap((l) => expandir(l.numerosAssociados, l.quantidade, l.duracaoMeses));
    // A quantidade no negócio tem de ser o total das subscrições (senão o cálculo sub-conta).
    const quantidade = subs.reduce((s, x) => s + x.quantidade, 0);
    try {
      const dealProductId = await adicionarProdutoAoNegocio(
        dealId,
        { produtoId: primeira.pipedriveProductId!, quantidade, precoUnitario: primeira.multaMensal, observacoes: observacoes(subs) },
        cred,
      );
      applied.push({ pricingPlanId: primeira.pricingPlanId, productId: primeira.pipedriveProductId!, quantity: quantidade, dealProductId });
    } catch (e) {
      if (!(e instanceof ErroPipedrive)) throw e;
      console.warn(`Falha a adicionar produto PPID ${primeira.pricingPlanId} ao deal ${dealId} (empresa ${empresaId}).`);
      errors.push({ pricingPlanId: primeira.pricingPlanId, error: e.message });
    }
  }
  return { applied, errors };
}

const estadoDe = (applied: unknown[], errors: unknown[]) => (errors.length === 0 ? "success" : applied.length === 0 ? "failed" : "partial");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ── Extract ──────────────────────────────────────────────────────────────────

export async function extract(pedido: Request): Promise<Response> {
  const corpo = await lerCorpo(pedido);
  const texto = str(corpo?.rawText) ?? "";
  if (!texto.trim()) return erro400("rawText obrigatório.");
  if (bytes(texto) > MAX_TEXTO_BYTES)
    return erro400(`Texto demasiado grande (máx. ${MAX_TEXTO_BYTES / 1024} KB). Cola apenas o output do simulador.`);

  const c = await contexto(pedido, "Empresa sem pipedrive_api_token — impossível listar catálogo.");
  if (c instanceof Response) return c;
  // O OAuth só se usa no Aplicar, mas sem ele não vale a pena mostrar o formulário.
  if (!(await escritaOAuth(c))) return autorizacaoNecessaria();

  let linhas;
  try {
    linhas = await extrairLinhas(texto);
  } catch (e) {
    if (!(e instanceof ErroExtracao)) throw e;
    console.warn(`Extract falhou (empresa ${c.empresaId}): ${e.message}`);
    return problema("Não foi possível extrair as linhas do texto. Tenta novamente ou revê o formato.", 502);
  }

  let catalogo: ProdutoCatalogo[];
  try {
    const key = await campoPpid(c);
    if (!key) return problema(`Campo de produto '${NOME_CAMPO_PPID}' não encontrado no Pipedrive desta conta. Cria o custom field nos produtos antes de usar esta funcionalidade.`, 500);
    catalogo = (await obterTodosProdutos(c.leitura)).map((p) => ({ id: p.id, nome: p.nome ?? "", pricingPlanId: campoComoTexto(p, key)?.trim() ?? "" }));
  } catch (e) {
    if (!(e instanceof ErroPipedrive)) throw e;
    console.warn(`Extract: falha a listar produtos Pipedrive (empresa ${c.empresaId}).`);
    return problema("Não foi possível consultar o catálogo do Pipedrive. Tenta novamente.", 502);
  }

  const resolucao = resolverLinhas(linhas, catalogo);
  for (const l of resolucao.linhas.filter((x) => x.status !== "ok"))
    console.info(`Extract: linha '${l.linha.nomeProduto}' ficou ${l.status} (empresa ${c.empresaId}, ${l.candidatos.length} candidatos).`);

  const { resultado, titulo } = await classificarSemFalhar(c, int(corpo?.dealId), resolucao.linhas.map((l) => l.pricingPlanId));

  return json({
    classificacaoAtiva: resultado.ativa,
    motivoInativa: resultado.motivoInativa,
    objetivoDoNegocio: resultado.nomeObjetivoDoNegocio,
    tituloNegocio: titulo,
    linhas: resolucao.linhas.map((l) => {
      const cl = daLinha(resultado, l.pricingPlanId);
      return {
        nomeProduto: l.linha.nomeProduto,
        quantidade: l.linha.quantidade,
        duracaoMeses: l.linha.duracaoContratoMeses,
        multaMensal: l.linha.multaMensal,
        pricingPlanId: l.pricingPlanId ?? "",
        pipedriveProductId: l.pipedriveProductId,
        nomeCanonico: l.nomeCanonico,
        status: l.status,
        origemResolucao: l.origem,
        candidatos: l.candidatos,
        classificacao: cl?.estado ?? null,
        linhaProduto: cl?.linhaProduto ?? null,
        atingimento: cl?.atingimento ?? null,
        porExcecao: cl?.porExcecao ?? false,
        funisAlvo: cl?.alvos ?? [],
      };
    }),
    linhasIgnoradas: resolucao.ignoradas,
  });
}

// ── Apply ────────────────────────────────────────────────────────────────────

export async function apply(pedido: Request): Promise<Response> {
  const corpo = await lerCorpo(pedido);
  const linhas = lerLinhas(corpo?.linhas);
  if (!linhas || linhas.length === 0) return erro400("Lista de linhas obrigatória.");
  // Obrigatório: é o que liga o negócio à simulação.
  const idSimulacao = str(corpo?.idSimulacao);
  if (!idSimulacao?.trim()) return erro400("ID do simulador obrigatório.");
  const texto = str(corpo?.rawText);
  if (texto !== null && bytes(texto) > MAX_TEXTO_BYTES) return erro400(`Texto demasiado grande (máx. ${MAX_TEXTO_BYTES / 1024} KB).`);

  const c = await contexto(pedido, "Empresa sem pipedrive_api_token — impossível validar o catálogo.");
  if (c instanceof Response) return c;
  // O deal vem do selectedIds do iframe (o JWT não o traz); o modal reencaminha-o.
  const dealId = int(corpo?.dealId);
  if (dealId <= 0) return erro400("dealId em falta ou inválido.");

  const oauth = await escritaOAuth(c);
  if (!oauth) return autorizacaoNecessaria();
  const aspnetUserId = await membroDoUtilizador(c.empresaId, c.id.pipedriveUserId);

  const invalida = validarLinhas(linhas);
  if (invalida) return erro400(invalida);

  try {
    const invalidas = await ppidsInvalidos(c, linhas);
    if (invalidas instanceof Response) return invalidas;
    if (invalidas.length > 0) {
      console.warn(`Apply: mapeamento PPID→produto inválido (empresa ${c.empresaId}, user ${c.id.pipedriveUserId}): ${invalidas.join(", ")}`);
      return erro400(`Mapeamento produto inválido para PPID(s): ${invalidas.join(", ")}. Repete a análise do texto.`);
    }
  } catch (e) {
    if (!(e instanceof ErroPipedrive)) throw e;
    return problema("Não foi possível validar o catálogo do Pipedrive. Tenta novamente.", 502);
  }

  // Revalidar o funil no servidor: produto no funil errado = comissão sobre a oferta errada.
  // Só se bloqueia com prova positiva; a exceção pontual passa com motivo e fica auditada.
  const { resultado } = await classificarSemFalhar(c, dealId, linhas.map((l) => l.pricingPlanId));
  const foraDoFunil: { pricingPlanId: string; nomeProduto: string; atingimento: string | null; motivo: string }[] = [];
  if (resultado.ativa) {
    const deOutro = linhas.filter((l) => daLinha(resultado, l.pricingPlanId)?.estado === "outro_funil");
    const motivoOk = (m: string | null) => !!m && m.trim().length >= MOTIVO_MINIMO;
    for (const l of deOutro.filter((x) => motivoOk(x.motivoForaDoFunil))) {
      const motivo = l.motivoForaDoFunil!.trim();
      foraDoFunil.push({ pricingPlanId: l.pricingPlanId, nomeProduto: l.nomeProduto, atingimento: daLinha(resultado, l.pricingPlanId)?.atingimento ?? null, motivo });
      console.warn(`Apply: produto de outro funil incluído no negócio ${dealId} (empresa ${c.empresaId}): ${l.pricingPlanId} ${l.nomeProduto} — motivo: ${motivo}`);
    }
    const forasteiras = [...new Map(deOutro.filter((l) => !motivoOk(l.motivoForaDoFunil)).map((l) => [l.nomeProduto.toLowerCase(), l.nomeProduto])).values()];
    if (forasteiras.length > 0)
      return erro400(`Estes produtos não pertencem ao funil deste negócio: ${forasteiras.join(", ")}. Para os incluir na mesma, indica o motivo em cada um.`);
  }

  // O id_simulador ANTES dos produtos: este PUT é idempotente, os produtos acrescentam.
  // Falhar aqui deixa o negócio intocado e repetir não duplica nada.
  const idSimuladorKey = await campoDoMapa(c.empresaId, "id_simulador");
  if (idSimuladorKey) {
    try {
      await atualizarNegocio(dealId, { [idSimuladorKey]: idSimulacao.trim() }, oauth);
    } catch (e) {
      if (!(e instanceof ErroPipedrive)) throw e;
      console.warn(`Apply: falha a gravar id_simulador no deal ${dealId} (empresa ${c.empresaId}). Nada foi aplicado.`);
      return problema("Não foi possível gravar o ID do simulador no negócio. Nada foi aplicado — tenta novamente.", 502);
    }
  } else {
    console.info(`Apply: campo 'id_simulador' não está no mapa de campos (empresa ${c.empresaId}) — ID guardado apenas na auditoria.`);
  }

  const { applied, errors } = await adicionarProdutos(dealId, linhas, oauth, c.empresaId);
  const status = estadoDe(applied, errors);
  const original = texto ?? "";
  await db.insert(sysContratoUploads).values({
    empresaId: c.empresaId,
    aspnetUserId,
    pipedriveDealId: dealId,
    pipedriveUserId: c.id.pipedriveUserId,
    idSimulacao,
    inputSha256: sha256(original),
    inputSizeBytes: bytes(original),
    uploadedAt: new Date(),
    parseStatus: "success",
    linhasExtraidas: linhas.length,
    linhasMapeadas: linhas.filter((l) => l.pipedriveProductId !== null).length,
    appliedAt: new Date(),
    appliedStatus: status,
    payloadJson: jsonComDecimais({ linhas, applied, errors, foraDoFunil }),
    errorMessage: errors.length > 0 ? errors.map((e) => `${e.pricingPlanId}: ${e.error}`).join("; ") : null,
  });
  return json({ status, applied, errors });
}

// ── Criar negócio-irmão ──────────────────────────────────────────────────────

/**
 * Cria um negócio no funil indicado, com os produtos que não pertencem ao de origem. A
 * operação mais delicada do modal (não há como apagar por aqui). Defesas, por ordem: o
 * id_simulador é obrigatório e é a chave; recusa se já houver negócio dessa simulação no
 * funil; valida que os produtos pertencem ao funil; cria o negócio e só depois os produtos.
 */
export async function criarNegocioIrmao(pedido: Request): Promise<Response> {
  const corpo = await lerCorpo(pedido);
  const linhas = lerLinhas(corpo?.linhas);
  if (!linhas || linhas.length === 0) return erro400("Lista de linhas obrigatória.");
  const idSimulacao = str(corpo?.idSimulacao)?.trim() ?? "";
  if (!idSimulacao) return erro400("ID do simulador obrigatório.");
  const titulo = str(corpo?.titulo)?.trim() ?? "";
  if (!titulo) return erro400("Título do negócio obrigatório.");
  const funil = int(corpo?.pipelineId);
  if (funil <= 0) return erro400("Funil de destino obrigatório.");
  const origemId = int(corpo?.dealOrigemId);
  if (origemId <= 0) return erro400("Negócio de origem em falta.");

  const c = await contexto(pedido, "Empresa sem pipedrive_api_token.");
  if (c instanceof Response) return c;
  const oauth = await escritaOAuth(c);
  if (!oauth) return autorizacaoNecessaria();
  const invalida = validarLinhas(linhas);
  if (invalida) return erro400(invalida);

  try {
    // 1. Já existe negócio desta simulação neste funil? (duplo clique, retry)
    for (const hit of await procurarNegociosPorCampo(idSimulacao, c.leitura)) {
      let funilDoHit = hit.funil;
      if (funilDoHit === null) {
        const detalhe = await obterNegocio(hit.id, c.leitura);
        funilDoHit = detalhe ? idDeCampo(detalhe, "pipeline_id") : null;
      }
      if (funilDoHit === funil) {
        console.info(`CriarNegocio: já existe o negócio ${hit.id} para a simulação ${idSimulacao} no funil ${funil} (empresa ${c.empresaId}) — não criado.`);
        return json({ error: `Já existe um negócio desta simulação neste funil (#${hit.id}). Não foi criado outro.`, dealId: hit.id }, 409);
      }
    }

    // 2. Os produtos pertencem mesmo ao funil de destino?
    const cl = await classificar(c.empresaId, funil, linhas.map((l) => l.pricingPlanId));
    if (cl.ativa) {
      const forasteiras = [...new Map(linhas.filter((l) => daLinha(cl, l.pricingPlanId)?.estado === "outro_funil").map((l) => [l.nomeProduto.toLowerCase(), l.nomeProduto])).values()];
      if (forasteiras.length > 0) return erro400(`Estes produtos não pertencem ao funil escolhido: ${forasteiras.join(", ")}.`);
    }

    // 3. PPID→produto contra o catálogo real
    const invalidas = await ppidsInvalidos(c, linhas);
    if (invalidas instanceof Response) return invalidas;
    if (invalidas.length > 0) return erro400(`Mapeamento produto inválido para PPID(s): ${invalidas.join(", ")}. Repete a análise do texto.`);

    // 4. Contacto e organização do negócio de origem (sem eles o novo nasce órfão)
    const origem = await obterNegocio(origemId, c.leitura);
    if (!origem) return erro400("Negócio de origem não encontrado no Pipedrive.");
    const idSimuladorKey = await campoDoMapa(c.empresaId, "id_simulador");

    // 5. O negócio primeiro, os produtos depois
    const novoId = await criarNegocio(
      {
        titulo,
        funil,
        pessoa: idDeCampo(origem, "person_id"),
        organizacao: idDeCampo(origem, "org_id"),
        camposPersonalizados: idSimuladorKey ? { [idSimuladorKey]: idSimulacao } : null,
      },
      oauth,
    );
    console.info(`CriarNegocio: negócio ${novoId} criado no funil ${funil} a partir de ${origemId} (empresa ${c.empresaId}, simulação ${idSimulacao}).`);

    const { applied, errors } = await adicionarProdutos(novoId, linhas, oauth, c.empresaId);
    const status = estadoDe(applied, errors);
    const original = str(corpo?.rawText) ?? "";
    await db.insert(sysContratoUploads).values({
      empresaId: c.empresaId,
      aspnetUserId: await membroDoUtilizador(c.empresaId, c.id.pipedriveUserId),
      pipedriveDealId: novoId,
      pipedriveUserId: c.id.pipedriveUserId,
      idSimulacao,
      inputSha256: sha256(original),
      inputSizeBytes: bytes(original),
      uploadedAt: new Date(),
      parseStatus: "success",
      linhasExtraidas: linhas.length,
      linhasMapeadas: linhas.length,
      appliedAt: new Date(),
      appliedStatus: status,
      payloadJson: jsonComDecimais({ criadoAPartirDe: origemId, funil, linhas, applied, errors }),
      errorMessage: errors.length > 0 ? errors.map((e) => `${e.pricingPlanId}: ${e.error}`).join("; ") : null,
    });
    return json({ status, dealId: novoId, applied, errors });
  } catch (e) {
    if (!(e instanceof ErroPipedrive)) throw e;
    console.warn(`CriarNegocio: falha (empresa ${c.empresaId}, origem ${origemId}, funil ${funil}): ${e.message}`);
    return problema(`Não foi possível criar o negócio no Pipedrive: ${e.message}`, 502);
  }
}

// ── Catálogo ─────────────────────────────────────────────────────────────────

export async function catalogo(pedido: Request): Promise<Response> {
  const c = await contexto(pedido, "Empresa sem pipedrive_api_token.");
  if (c instanceof Response) return c;
  const chave = `pd-catalog:${c.empresaId}`;
  const guardado = emCache<unknown[]>(chave);
  if (guardado) return json(guardado);
  try {
    const key = await campoPpid(c);
    if (!key) return erroCampoPpid();
    const produtos = [...indicePorPpid(await obterTodosProdutos(c.leitura), key)]
      .map(([ppid, p]) => ({ productId: p.id, nome: p.nome ?? "", pricingPlanId: ppid }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt", { sensitivity: "base" }));
    guardar(chave, produtos, 5 * 60_000);
    return json(produtos);
  } catch (e) {
    if (!(e instanceof ErroPipedrive)) throw e;
    console.warn(`Catalog: falha a listar produtos Pipedrive (empresa ${c.empresaId}).`);
    return problema("Não foi possível consultar o catálogo do Pipedrive. Tenta novamente.", 502);
  }
}

// ── Sessão ───────────────────────────────────────────────────────────────────

/**
 * O JWT do iframe expira em ~5 min. Quem tem um válido recebe um nosso, com os mesmos claims
 * e 30 min, assinado com o mesmo client_secret (o validador aceita-o sem alterações).
 * É extensão de janela, não elevação de privilégio.
 */
export async function estenderSessao(pedido: Request): Promise<Response> {
  const auth = await autenticarModal(pedido);
  if (auth instanceof Response) return auth;
  const agora = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ user_id: String(auth.id.pipedriveUserId), company_id: String(auth.id.pipedriveCompanyId) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(agora)
    .setNotBefore(agora)
    .setExpirationTime(agora + SESSAO_MIN * 60)
    .sign(new TextEncoder().encode(auth.cfg.clientSecret));
  return json({ token, expiresInSeconds: SESSAO_MIN * 60 });
}
