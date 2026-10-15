// Subscrições de uma linha do modal e as observações escritas no produto do negócio. Puro.
// Port de Shared/Pipedrive/SubscricaoExpander.cs e de AdicionarProdutosAoDealAsync.
// O formato é o que src/lib/calculo/observacoes.ts lê a jusante.

/** 1.ª linha das observações, antes do JSON; o parser lê a partir do primeiro '{'. */
export const CABECALHO_OBSERVACOES = "⚠ Gerado pela app Preencher Produtos — não remover.";

export interface SubscricaoExpandida {
  numero: string | null;
  duracaoMeses: number;
  quantidade: number;
}

/**
 * Com números: uma subscrição por número, quantidade 1 (cada número é um contrato).
 * Sem números: UMA subscrição com a quantidade toda (cálculo sobre o total).
 */
export function expandir(numeros: readonly (string | null)[] | null | undefined, quantidade: number, duracaoMeses: number): SubscricaoExpandida[] {
  const validos = (numeros ?? []).map((n) => n?.trim()).filter((n): n is string => !!n);
  if (validos.length > 0) return validos.map((numero) => ({ numero, duracaoMeses, quantidade: 1 }));
  return [{ numero: null, duracaoMeses, quantidade: Math.max(1, quantidade) }];
}

/** As observações do produto: o aviso e, na linha seguinte, o JSON das subscrições. */
export function observacoes(subs: readonly SubscricaoExpandida[]): string {
  const subscricoes = subs.map((s) => ({ numero: s.numero, duracao_meses: s.duracaoMeses, quantidade: s.quantidade }));
  return `${CABECALHO_OBSERVACOES}\n${JSON.stringify({ subscricoes })}`;
}

/** Os números colados: separados por nova linha, vírgula, espaço, ponto e vírgula ou tab. */
export function lerNumeros(texto: string | null | undefined): string[] {
  return (texto ?? "").split(/[\n\r, ;\t]+/).map((n) => n.trim()).filter(Boolean);
}
