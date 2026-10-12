// Upfront (a comissão paga no momento da venda) de uma linha de produto Vodafone.
// Port fiel de Infrastructure/Services/Vodafone/UpfrontCalculator.cs, operação a operação
// e pela mesma ordem, para os arredondamentos internos do decimal serem os mesmos.

import { NetDecimal } from "./decimal-net";

export interface UpfrontLinhaInput {
  /** RLMC contratada (item_price do produto no Pipedrive). */
  valorUnidade: NetDecimal;
  quantidade: number;
  /** Ponderador de upfront do plano comissional (patamar 0). */
  upfrontPlano: NetDecimal;
  /** Fator por duração contratual (0.4, 1.0, 1.5, …). */
  ajusteDuracao: NetDecimal;
  /** % retida pelo parceiro; null → 100 (parceiro salvaguardado, o comercial não recebe). */
  margemUpfrontPct: NetDecimal | null;
}

export interface UpfrontLinhaResultado {
  valorBruto: NetDecimal;
  valorLiquido: NetDecimal;
}

/**
 *   valor_bruto   = (preço × ajuste) × upfront × quantidade, a 2 casas
 *   valor_liquido = valor_bruto × (1 − margem/100), a 2 casas
 *
 * Margem null → 100: sem margem configurada o parceiro retém tudo e o comercial não
 * recebe (o n8n original assumia 0; essa semântica só vale no replay histórico).
 */
export function calcularUpfront(input: UpfrontLinhaInput): UpfrontLinhaResultado {
  const margem = (input.margemUpfrontPct ?? NetDecimal.CEM).div(NetDecimal.CEM);

  const valorBruto = input.valorUnidade
    .times(input.ajusteDuracao)
    .times(input.upfrontPlano)
    .times(input.quantidade)
    .round(2);

  const valorLiquido = valorBruto.times(NetDecimal.UM.minus(margem)).round(2);

  return { valorBruto, valorLiquido };
}
