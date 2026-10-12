// Prémio trimestral de cada linha de produto Vodafone.
// Port fiel de Infrastructure/Services/Vodafone/TrimestralPremiosCalculator.cs (que por
// sua vez é 1:1 com o Function node "Calcular Prémio" do n8n), operação a operação.

import { NetDecimal } from "./decimal-net";

/** Uma linha de sys_calculo_comissoes já materializada com o cabeçalho do negócio. */
export interface LinhaProdutoInput {
  idCalculoComissoes: string;
  idSysNegocio: string;
  /** sys_negocios.id_funil, já convertido para inteiro. */
  idFunilPipedrive: number;
  /** sys_negocios.id_tipo_receita. */
  idTipoReceita: number;
  /** sys_calculo_comissoes.oferta, já convertida para inteiro. */
  oferta: number;
  /** RLMC. */
  valorUnidade: NetDecimal;
  quantidade: number;
  /** Ponderador de upfront da linha (não confundir com o upfront pago). */
  upfrontLinha: NetDecimal;
  /** null → 1. */
  ajusteDuracao: NetDecimal | null;
  /** % retida pelo parceiro; null → 100 (parceiro salvaguardado, o comercial não recebe). */
  margemPremioPct: NetDecimal | null;
}

/** Uma métrica de objetivo trimestral, com as colunas calculadas da BD já resolvidas. */
export interface ObjetivoTrimestralInput {
  idObjetivo: number;
  idFunilPipedrive: number;
  /** Coluna gerada da BD; teto 1.0. */
  posicionamento: NetDecimal;
  /** Coluna gerada da BD; pode passar de 1. */
  pctAtingimento: NetDecimal;
  /** Coluna gerada da BD; sse pct_atingimento ≥ 0.90. */
  atingido: boolean;
}

/** Entrada do plano comissional para o patamar (nº de objetivos atingidos) apurado. */
export interface PlanoComissionalInput {
  tipoReceita: number;
  oferta: number;
  /** Coluna "upfront" de ref_plano_comissional_vodafone. */
  ponderadorPremio: NetDecimal;
}

/** Faixa da Figura 3 do plano (posicionamento da própria linha): [pctMin, pctMax). */
export interface AjustePropriaLinhaInput {
  pctMin: NetDecimal;
  pctMax: NetDecimal;
  ajuste: NetDecimal;
}

/**
 * Contexto imutável do apuramento. Onde há várias entradas possíveis ganha a PRIMEIRA
 * da lista (como o FirstOrDefault do C#), por isso a ordem tem de vir determinística.
 */
export interface ApuramentoContexto {
  objetivos: readonly ObjetivoTrimestralInput[];
  /** Já filtrado para objetivos_atingidos = patamar. */
  planoDoPatamar: readonly PlanoComissionalInput[];
  ajustesPropriaLinha: readonly AjustePropriaLinhaInput[];
  ajusteCruzado: NetDecimal;
}

export type LinhaPremioErro = "ponderador-nao-encontrado" | "objetivo-linha-nao-encontrado";

/** erro ≠ null significa "não calcula prémio" (não se gravam premios_*). */
export type LinhaPremioResultado =
  | { idCalculoComissoes: string; premioBruto: NetDecimal; premioLiquido: NetDecimal; erro: null }
  | { idCalculoComissoes: string; premioBruto: null; premioLiquido: null; erro: LinhaPremioErro };

export function calcularPremio(linha: LinhaProdutoInput, ctx: ApuramentoContexto): LinhaPremioResultado {
  const ponderador = ctx.planoDoPatamar.find(
    (p) => p.oferta === linha.oferta && p.tipoReceita === linha.idTipoReceita,
  );
  if (!ponderador) return falha(linha, "ponderador-nao-encontrado");

  const objetivoDaLinha = ctx.objetivos.find((o) => o.idFunilPipedrive === linha.idFunilPipedrive);
  if (!objetivoDaLinha) return falha(linha, "objetivo-linha-nao-encontrado");

  // Filtro 1 — atingimento (vendas vs acordado): abaixo de 90% não liberta prémio;
  // ≥ 90% aplica proporcional, com teto a 100%.
  const fatorAtingimento = objetivoDaLinha.atingido
    ? NetDecimal.min(objetivoDaLinha.pctAtingimento, NetDecimal.UM)
    : NetDecimal.ZERO;

  // Filtro 2 — posicionamento (acordado vs proposto):
  //   pos ≥ 1 → ajuste cruzado (Fig. 4)
  //   pos < 1 → ajuste da própria linha (Fig. 3), pela faixa em que pos cai
  //   pos abaixo da menor faixa configurada → fator 0 (por design)
  let fatorPosicionamento: NetDecimal;
  if (objetivoDaLinha.posicionamento.gte(NetDecimal.UM)) {
    fatorPosicionamento = ctx.ajusteCruzado;
  } else {
    const pos = objetivoDaLinha.posicionamento;
    const faixa = ctx.ajustesPropriaLinha.find((f) => pos.gte(f.pctMin) && pos.lt(f.pctMax));
    fatorPosicionamento = faixa?.ajuste ?? NetDecimal.ZERO;
  }

  const ajusteDuracao = linha.ajusteDuracao ?? NetDecimal.UM;

  // Margem null → 100 (parceiro salvaguardado). O n8n original assumia 0.
  const margem = (linha.margemPremioPct ?? NetDecimal.CEM).div(NetDecimal.CEM);

  // A diferença pode dar negativa se o ponderador de prémio < upfront da linha —
  // comportamento herdado do n8n, preservado de propósito.
  const diferenca = ponderador.ponderadorPremio.minus(linha.upfrontLinha);
  const baseCalc = linha.valorUnidade.times(diferenca).times(linha.quantidade);

  const premioBruto = baseCalc.times(fatorAtingimento).times(fatorPosicionamento).times(ajusteDuracao).round(2);
  const premioLiquido = premioBruto.times(NetDecimal.UM.minus(margem)).round(2);

  return { idCalculoComissoes: linha.idCalculoComissoes, premioBruto, premioLiquido, erro: null };
}

function falha(linha: LinhaProdutoInput, erro: LinhaPremioErro): LinhaPremioResultado {
  return { idCalculoComissoes: linha.idCalculoComissoes, premioBruto: null, premioLiquido: null, erro };
}

/** Quantas métricas foram atingidas (o patamar do plano). Só o atingimento conta. */
export function contarObjetivosAtingidos(objetivos: Iterable<ObjetivoTrimestralInput>): number {
  let n = 0;
  for (const o of objetivos) if (o.atingido) n++;
  return n;
}
