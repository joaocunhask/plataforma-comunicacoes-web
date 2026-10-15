// Cliente da API do Pipedrive. Port de Infrastructure/Services/Pipedrive/PipedriveClient.cs,
// só com o que o apuramento usa (o resto entra com o modal).
//
// Autenticação: o personal API token da empresa vai na query string (?api_token=); um access
// token OAuth vai como Bearer. Não são intermutáveis: o formato errado dá 401.
import { inteiro, decimal, objeto, parseJsonExato, texto, type ObjetoJson } from "./json-exato";
import { NetDecimal } from "@/lib/calculo";

export class ErroPipedrive extends Error {
  constructor(
    mensagem: string,
    readonly statusCode?: number,
  ) {
    super(mensagem);
    this.name = "ErroPipedrive";
  }
}

export type Credencial = { tipo: "api-token"; token: string } | { tipo: "oauth"; accessToken: string; apiDomain?: string };

export interface ProdutoNoNegocio {
  id: number;
  produtoId: number;
  nome: string | null;
  precoUnitario: NetDecimal;
  quantidade: number;
  observacoes: string | null;
}

/** Um registo (produto ou negócio) com os campos todos, para ler custom fields pela key (hash). */
export interface Registo {
  id: number;
  nome: string | null;
  campos: ObjetoJson;
}

const BASE_URL = process.env.PIPEDRIVE_BASE_URL ?? "https://api.pipedrive.com";
const TIMEOUT_MS = 30_000;

/** Valor de um custom field como texto: string, ou número com o texto original. */
export function campoComoTexto(registo: Registo, key: string): string | null {
  return texto(registo.campos[key]);
}

/** Dono do negócio: owner_id (v2) ou user_id (v1), número ou objeto {id}. */
export function donoDoNegocio(negocio: Registo): number | null {
  for (const chave of ["owner_id", "user_id"]) {
    const v = negocio.campos[chave];
    const n = inteiro(v) ?? inteiro(objeto(v)?.id);
    if (n !== null) return n;
  }
  return null;
}

const getJson = (caminho: string, cred: Credencial, permitir404: boolean) => pedir("GET", caminho, cred, null, permitir404);

/** `corpo` já serializado (ver jsonComDecimais): o dinheiro vai como número exato. */
async function pedir(
  metodo: "GET" | "POST" | "PUT",
  caminho: string,
  cred: Credencial,
  corpo: string | null,
  permitir404: boolean,
): Promise<ObjetoJson | null> {
  const base = cred.tipo === "oauth" && cred.apiDomain ? cred.apiDomain : BASE_URL;
  const url = new URL(caminho, base);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cred.tipo === "api-token") url.searchParams.set("api_token", cred.token);
  else headers.Authorization = `Bearer ${cred.accessToken}`;
  if (corpo !== null) headers["Content-Type"] = "application/json";

  let resposta: Response;
  try {
    resposta = await fetch(url, { method: metodo, headers, body: corpo, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    throw new ErroPipedrive(timeout ? "Timeout ao contactar o Pipedrive." : "Falha de rede ao contactar o Pipedrive.");
  }
  if (permitir404 && resposta.status === 404) return null;
  const corpoResposta = await resposta.text();
  if (!resposta.ok) {
    console.warn(`Pipedrive respondeu ${resposta.status} para ${metodo} ${caminho}: ${corpoResposta.slice(0, 500)}`);
    throw new ErroPipedrive(
      metodo === "GET" ? `Pipedrive devolveu ${resposta.status}.` : `Pipedrive devolveu ${resposta.status} para ${metodo} ${caminho}.`,
      resposta.status,
    );
  }
  const doc = objeto(parseJsonExato(corpoResposta));
  if (doc?.success === false) throw new ErroPipedrive("Pipedrive respondeu com success=false.");
  return doc;
}

function registo(data: ObjetoJson, onde: string): Registo {
  const id = inteiro(data.id);
  if (id === null) throw new ErroPipedrive(`Resposta ${onde} sem 'id' válido.`);
  return { id, nome: typeof data.name === "string" ? data.name : null, campos: data };
}

/** GET /v1/deals/{id}/products. */
export async function obterProdutosDoNegocio(dealId: number, cred: Credencial): Promise<ProdutoNoNegocio[]> {
  const doc = await getJson(`/v1/deals/${dealId}/products`, cred, false);
  const data = doc?.data;
  if (!Array.isArray(data)) return [];
  return data.map((item) => {
    const o = objeto(item) ?? {};
    const id = inteiro(o.id);
    const produtoId = inteiro(o.product_id);
    const preco = decimal(o.item_price);
    const quantidade = inteiro(o.quantity);
    if (id === null || produtoId === null || preco === null || quantidade === null)
      throw new ErroPipedrive(`Produto do negócio ${dealId} com campos em falta.`);
    return {
      id,
      produtoId,
      nome: typeof o.name === "string" ? o.name : null,
      precoUnitario: preco,
      quantidade,
      observacoes: typeof o.comments === "string" ? o.comments : null,
    };
  });
}

/** GET /v1/products/{id}; null se não existir. */
export async function obterProduto(produtoId: number, cred: Credencial): Promise<Registo | null> {
  const doc = await getJson(`/v1/products/${produtoId}`, cred, true);
  if (doc === null) return null;
  const data = objeto(doc.data);
  if (!data) throw new ErroPipedrive(`Resposta /products/${produtoId} sem 'data' válido.`);
  return registo(data, `/products/${produtoId}`);
}

/** GET /v1/deals/{id}; null se não existir. */
export async function obterNegocio(dealId: number, cred: Credencial): Promise<Registo | null> {
  const doc = await getJson(`/v1/deals/${dealId}`, cred, true);
  if (doc === null) return null;
  const data = objeto(doc.data);
  if (!data) throw new ErroPipedrive(`Resposta /deals/${dealId} sem 'data' válido.`);
  return registo(data, `/deals/${dealId}`);
}

/** O que o apuramento precisa do Pipedrive (trocável nos testes). */
export interface ApiPipedrive {
  obterProdutosDoNegocio: typeof obterProdutosDoNegocio;
  obterProduto: typeof obterProduto;
  obterNegocio: typeof obterNegocio;
}

export const apiPipedrive: ApiPipedrive = { obterProdutosDoNegocio, obterProduto, obterNegocio };

/** GET /v1/users/me com um access token OAuth: quem autorizou (a identidade autoritativa). */
export async function utilizadorAtual(accessToken: string): Promise<{ id: number; companyId: number; nome: string | null }> {
  const doc = await getJson("/v1/users/me", { tipo: "oauth", accessToken }, false);
  const data = objeto(doc?.data);
  const id = data && inteiroLongo(data.id);
  const companyId = data && inteiroLongo(data.company_id);
  if (!data || id == null || companyId == null) throw new ErroPipedrive("Resposta /users/me sem 'data' válido.");
  return { id, companyId, nome: typeof data.name === "string" ? data.name : null };
}

/** GetInt64: os ids de utilizador e de conta do Pipedrive cabem num número seguro. */
function inteiroLongo(v: unknown): number | null {
  const t = texto(v);
  if (t === null || typeof v === "string" || !/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

// ── Para o modal ─────────────────────────────────────────────────────────────

const MARCA = "\u0000dec:";

/**
 * JSON.stringify com os NetDecimal escritos como números exatos ("22.50", não 22.5 via float),
 * como o System.Text.Json fazia com decimal.
 */
export function jsonComDecimais(valor: unknown): string {
  // O replacer vê o valor já passado pelo toJSON do NetDecimal (texto): lê-se o original.
  const s = JSON.stringify(valor, function (this: Record<string, unknown>, k, v) {
    const original = this[k];
    return original instanceof NetDecimal ? `${MARCA}${original.toString()}` : v;
  });
  return s.replace(/"\\u0000dec:(-?\d+(?:\.\d+)?)"/g, "$1"); // o JSON escreve o NUL como \u0000
}

/** Um id que vem como número ou como objeto: {id} (v2) ou {value} (v1, ex.: person_id, org_id). */
export function idDeCampo(registo: Registo, chave: string): number | null {
  const v = registo.campos[chave];
  const o = objeto(v);
  return inteiro(v) ?? inteiro(o?.id) ?? inteiro(o?.value);
}

/** GET /v1/products, todas as páginas (500 de cada vez). */
export async function obterTodosProdutos(cred: Credencial): Promise<Registo[]> {
  const todos: Registo[] = [];
  let inicio = 0;
  for (;;) {
    const doc = await getJson(`/v1/products?limit=500&start=${inicio}`, cred, false);
    if (!doc) throw new ErroPipedrive("Resposta vazia de /v1/products.");
    if (Array.isArray(doc.data)) for (const item of doc.data) { const o = objeto(item); if (o) todos.push(registo(o, "/v1/products")); }
    const pag = objeto(objeto(doc.additional_data)?.pagination);
    if (pag?.more_items_in_collection !== true) break;
    inicio = inteiro(pag.next_start) ?? inicio + 500;
  }
  return todos;
}

/** GET /v1/productFields: key (hash) e nome de cada campo. */
export async function obterCamposDeProduto(cred: Credencial): Promise<{ key: string; nome: string }[]> {
  const doc = await getJson("/v1/productFields", cred, false);
  if (!doc) throw new ErroPipedrive("Resposta vazia de /v1/productFields.");
  if (!Array.isArray(doc.data)) return [];
  return doc.data
    .map(objeto)
    .filter((o): o is ObjetoJson => !!o && typeof o.key === "string")
    .map((o) => ({ key: o.key as string, nome: typeof o.name === "string" ? o.name : "" }));
}

/** GET /v1/deals/search por um valor exato nos custom fields. O funil nem sempre vem. */
export async function procurarNegociosPorCampo(termo: string, cred: Credencial): Promise<{ id: number; titulo: string | null; funil: number | null }[]> {
  if (!termo.trim()) return [];
  const doc = await getJson(`/v1/deals/search?term=${encodeURIComponent(termo)}&fields=custom_fields&exact_match=true`, cred, true);
  const items = objeto(doc?.data)?.items;
  if (!Array.isArray(items)) return [];
  const hits = [];
  for (const w of items) {
    const item = objeto(objeto(w)?.item);
    const id = item ? inteiro(item.id) : null;
    if (!item || id === null) continue;
    hits.push({ id, titulo: typeof item.title === "string" ? item.title : null, funil: inteiro(objeto(item.pipeline)?.id) });
  }
  return hits;
}

/** POST /v1/deals. Sem stage_id: o Pipedrive põe-no na 1.ª fase do funil. */
export async function criarNegocio(
  dados: { titulo: string; funil: number; pessoa: number | null; organizacao: number | null; camposPersonalizados: Record<string, unknown> | null },
  cred: Credencial,
): Promise<number> {
  const corpo: Record<string, unknown> = { title: dados.titulo, pipeline_id: dados.funil };
  if (dados.pessoa !== null) corpo.person_id = dados.pessoa;
  if (dados.organizacao !== null) corpo.org_id = dados.organizacao;
  Object.assign(corpo, dados.camposPersonalizados ?? {});
  const doc = await pedir("POST", "/v1/deals", cred, jsonComDecimais(corpo), false);
  const id = inteiro(objeto(doc?.data)?.id);
  if (id === null) throw new ErroPipedrive("Resposta de criação de negócio sem 'data.id'.");
  return id;
}

/** PUT /v1/deals/{id} com os campos dados (no-op se não houver nenhum). */
export async function atualizarNegocio(dealId: number, campos: Record<string, unknown>, cred: Credencial): Promise<void> {
  if (Object.keys(campos).length === 0) return;
  await pedir("PUT", `/v1/deals/${dealId}`, cred, jsonComDecimais(campos), false);
}

/** POST /v1/deals/{id}/products. ACRESCENTA: chamar duas vezes duplica o produto. */
export async function adicionarProdutoAoNegocio(
  dealId: number,
  produto: { produtoId: number; quantidade: number; precoUnitario: NetDecimal; observacoes: string | null },
  cred: Credencial,
): Promise<number> {
  const corpo = { product_id: produto.produtoId, quantity: produto.quantidade, item_price: produto.precoUnitario, comments: produto.observacoes };
  const doc = await pedir("POST", `/v1/deals/${dealId}/products`, cred, jsonComDecimais(corpo), false);
  const id = inteiro(objeto(doc?.data)?.id);
  if (id === null) throw new ErroPipedrive("Resposta ao adicionar produto sem 'data' válido.");
  return id;
}
