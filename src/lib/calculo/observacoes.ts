// Leitura das observações (campo "comments") de um produto do negócio no Pipedrive,
// no formato escrito pela app Preencher Produtos:
//
//   ⚠ Gerado pela app Preencher Produtos — não remover.
//   {"subscricoes":[{"numero":"912...","duracao_meses":30,"quantidade":1}]}
//
// Port fiel de DealProductCommentsParser.Parse (Infrastructure/Services/Pipedrive).
// Inclui as arestas do System.Text.Json que mudam o resultado: profundidade máxima 64,
// e um número que não seja um Int32 literal lança (no C# é um FormatException que não é
// apanhado e faz o webhook falhar — aqui é um ObservacoesInvalidasError).

import { trimNet, vazioOuEspacosNet } from "./texto-net";

/**
 * Uma subscrição. O número é opcional (há produtos sem número associado).
 * quantidade: número → 1; sem número → N unidades numa só subscrição (cálculo sobre o total).
 */
export interface SubscricaoContrato {
  numero: string | null;
  duracaoMeses: number;
  quantidade: number;
}

/** O equivalente ao FormatException do JsonElement.GetInt32 no C#. */
export class ObservacoesInvalidasError extends Error {
  constructor(campo: string, fonte: string) {
    super(`Observações do produto: "${campo}" não é um inteiro de 32 bits (${fonte}).`);
    this.name = "ObservacoesInvalidasError";
  }
}

/** Número JSON com o texto original, para validar como o GetInt32 do .NET. */
class NumeroJson {
  constructor(
    readonly fonte: string,
    readonly valor: number,
  ) {}
}

const PROFUNDIDADE_MAX_JSON = 64; // JsonDocumentOptions.MaxDepth por omissão
const INT32_LITERAL = /^-?(0|[1-9]\d*)$/;

export function lerSubscricoes(observacoes: string | null | undefined): SubscricaoContrato[] {
  if (observacoes == null || vazioOuEspacosNet(observacoes)) return [];

  const inicio = observacoes.indexOf("{");
  if (inicio < 0) return [];

  let raiz: unknown;
  try {
    raiz = JSON.parse(observacoes.slice(inicio), (_chave, valor, contexto?: { source?: string }) =>
      typeof valor === "number" ? new NumeroJson(contexto?.source ?? String(valor), valor) : valor,
    );
  } catch {
    return [];
  }
  if (excedeProfundidade(raiz, PROFUNDIDADE_MAX_JSON)) return [];

  const lista = (raiz as Record<string, unknown>).subscricoes;
  if (!Array.isArray(lista)) return [];

  const subscricoes: SubscricaoContrato[] = [];
  for (const item of lista) {
    if (!eObjeto(item)) continue;

    const numero = typeof item.numero === "string" ? item.numero : null;
    const duracaoMeses = item.duracao_meses instanceof NumeroJson ? int32("duracao_meses", item.duracao_meses) : 0;
    // Quantidade ausente = 1 (retrocompat com observações antigas).
    const quantidade = item.quantidade instanceof NumeroJson ? Math.max(1, int32("quantidade", item.quantidade)) : 1;

    subscricoes.push({
      numero: numero == null || vazioOuEspacosNet(numero) ? null : trimNet(numero),
      duracaoMeses,
      quantidade,
    });
  }
  return subscricoes;
}

function eObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor) && !(valor instanceof NumeroJson);
}

/** JsonElement.GetInt32: só um literal inteiro (sem fração nem expoente) dentro de Int32. */
function int32(campo: string, n: NumeroJson): number {
  if (INT32_LITERAL.test(n.fonte)) {
    const v = BigInt(n.fonte);
    if (v >= -(2n ** 31n) && v <= 2n ** 31n - 1n) return Number(v);
  }
  throw new ObservacoesInvalidasError(campo, n.fonte);
}

/** Se o aninhamento de objetos/arrays passa do limite (a raiz conta 1). Para cedo. */
function excedeProfundidade(valor: unknown, restante: number): boolean {
  if (typeof valor !== "object" || valor === null || valor instanceof NumeroJson) return false;
  if (restante === 0) return true;
  for (const filho of Object.values(valor)) if (excedeProfundidade(filho, restante - 1)) return true;
  return false;
}
