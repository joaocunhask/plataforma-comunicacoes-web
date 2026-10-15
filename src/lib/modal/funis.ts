// A que funil pertence um produto. Puro. Port de Shared/Funis/ClassificadorFunil.cs e
// ExcecoesFunil.cs.
//
// O funil sai do par (linha de atingimento do produto × tipo de receita):
//   GSM + Nova → Nova RLMC Móvel · GSM + Refid → Refidelização RLMC Móvel & IoT
//   Fixo + Nova → Nova RLMC Fixo · Fixo + Refid → Refidelização RLMC Fixo & ICT
//   Smart Solutions + Nova → Nova RLMC Smart Solutions
// Nunca adivinha: sem atingimento, sem mapeamento ou com um tipo de receita desconhecido, a
// resposta é "não classificado" e decide o comercial.

/** Ids de ref_tipo_receitas (catálogo global). NovoNegocio fica de propósito sem classificação. */
export const TiposReceita = { NovaReceita: 1, Refidelizacao: 2, NovoNegocio: 6 } as const;

export interface ObjetivoFunil {
  objetivoId: number;
  idFunilPipedrive: number;
  nomeFunil: string | null;
  atingimentoLinha: string | null;
  idTipoReceita: number | null;
}

/** Os Pacotes Convergentes vêm como "GSM e/ou FIXO": contam para as duas linhas. */
const SEPARADOR_MULTIPLO = "E/OU";

/** Maiúsculas, sem acentos, espaços colapsados ("Smart Solutions" = "SMART SOLUTIONS"). */
export function normalizarAtingimento(valor: string | null | undefined): string {
  if (!valor || !valor.trim()) return "";
  return valor.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC").split(/\s+/).filter(Boolean).join(" ").toUpperCase();
}

/** As linhas a que o atingimento conta. Vazio = sem informação (nunca "não pertence a nada"). */
export function decompor(atingimento: string | null | undefined): Set<string> {
  const n = normalizarAtingimento(atingimento);
  return new Set(n ? n.split(SEPARADOR_MULTIPLO).map((p) => p.trim()).filter(Boolean) : []);
}

/** Qual dos atingimentos do produto se aplica, dado o tipo de receita (null se não sabemos ler). */
export function atingimentoDoProduto(idTipoReceita: number | null, nova: string | null, refid: string | null): string | null {
  if (idTipoReceita === TiposReceita.NovaReceita) return nova;
  if (idTipoReceita === TiposReceita.Refidelizacao) return refid;
  return null;
}

/** Os objetivos (funis) a que o produto pertence: normalmente um, dois nos convergentes, zero sem dados. */
export function resolverFunis(atingimento: string | null, idTipoReceita: number | null, objetivos: readonly ObjetivoFunil[]): ObjetivoFunil[] {
  const alvos = decompor(atingimento);
  if (alvos.size === 0 || idTipoReceita === null) return [];
  return objetivos.filter((o) => {
    if (o.idTipoReceita !== idTipoReceita) return false;
    const doObjetivo = normalizarAtingimento(o.atingimentoLinha);
    return doObjetivo.length > 0 && alvos.has(doObjetivo);
  });
}

export function pertenceAoFunil(nova: string | null, refid: string | null, objetivo: ObjetivoFunil): boolean {
  const alvos = decompor(atingimentoDoProduto(objetivo.idTipoReceita, nova, refid));
  if (alvos.size === 0) return false;
  const doObjetivo = normalizarAtingimento(objetivo.atingimentoLinha);
  return doObjetivo.length > 0 && alvos.has(doObjetivo);
}

// ── Exceções (ref_funil_excecoes) ────────────────────────────────────────────

export interface ExcecaoFunil {
  criterio: string;
  valor: string;
  idTipoReceita: number | null;
  atingimentoLinha: string;
}

export interface ProdutoParaExcecao {
  pricingPlanId: string;
  linhaProduto: string | null;
  areaProduto: string | null;
  subareaProduto: string | null;
}

export function excecaoApanha(e: ExcecaoFunil, p: ProdutoParaExcecao): boolean {
  // O PPID é um código: compara-se exato. O resto é texto do Excel: normaliza-se.
  if (e.criterio === "PPID") return (e.valor ?? "").trim() === (p.pricingPlanId ?? "").trim();
  const campo = e.criterio === "LINHA" ? p.linhaProduto : e.criterio === "AREA" ? p.areaProduto : e.criterio === "SUBAREA" ? p.subareaProduto : null;
  const valor = normalizarAtingimento(e.valor);
  return valor.length > 0 && valor === normalizarAtingimento(campo);
}

/**
 * O atingimento depois das exceções, para um tipo de receita. Acrescenta linhas, nunca
 * substitui ("GSM E/OU FIXO"); sem atingimento não mexe (dar-lhe só a da exceção bloqueava-o
 * nos outros funis).
 */
export function aplicarExcecoes(
  atingimento: string | null,
  idTipoReceita: number,
  produto: ProdutoParaExcecao,
  excecoes: readonly ExcecaoFunil[],
): { atingimento: string | null; porExcecao: boolean } {
  const linhas = decompor(atingimento);
  if (linhas.size === 0) return { atingimento, porExcecao: false };
  const extra: string[] = [];
  for (const e of excecoes) {
    if (e.idTipoReceita !== null && e.idTipoReceita !== idTipoReceita) continue;
    if (!excecaoApanha(e, produto)) continue;
    const linha = normalizarAtingimento(e.atingimentoLinha);
    if (!linha || linhas.has(linha) || extra.includes(linha)) continue;
    extra.push(linha);
  }
  if (extra.length === 0) return { atingimento, porExcecao: false };
  return { atingimento: [...linhas, ...extra].join(" E/OU "), porExcecao: true };
}
