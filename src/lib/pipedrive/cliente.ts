// Cliente da API do Pipedrive. Port de Infrastructure/Services/Pipedrive/PipedriveClient.cs,
// só com o que o apuramento usa (o resto entra com o modal).
//
// Autenticação: o personal API token da empresa vai na query string (?api_token=); um access
// token OAuth vai como Bearer. Não são intermutáveis: o formato errado dá 401.
import { inteiro, decimal, objeto, parseJsonExato, texto, type ObjetoJson } from "./json-exato";
import type { NetDecimal } from "@/lib/calculo";

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

async function getJson(caminho: string, cred: Credencial, permitir404: boolean): Promise<ObjetoJson | null> {
  const base = cred.tipo === "oauth" && cred.apiDomain ? cred.apiDomain : BASE_URL;
  const url = new URL(caminho, base);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cred.tipo === "api-token") url.searchParams.set("api_token", cred.token);
  else headers.Authorization = `Bearer ${cred.accessToken}`;

  let resposta: Response;
  try {
    resposta = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    throw new ErroPipedrive(timeout ? "Timeout ao contactar o Pipedrive." : "Falha de rede ao contactar o Pipedrive.");
  }
  if (permitir404 && resposta.status === 404) return null;
  const corpo = await resposta.text();
  if (!resposta.ok) {
    console.warn(`Pipedrive respondeu ${resposta.status} para ${caminho}: ${corpo.slice(0, 500)}`);
    throw new ErroPipedrive(`Pipedrive devolveu ${resposta.status}.`, resposta.status);
  }
  const doc = objeto(parseJsonExato(corpo));
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
