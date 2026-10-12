// ref_tipo_acerto.id — port de TiposAcerto (Infrastructure/Models/RefTipoAcerto.cs).

export const TiposAcerto = {
  /** Duração ou data de início mal introduzidas. Recalcula; só em ATIVO. */
  CorrecaoDados: 1,
  /** Alinhar com o valor que a Vodafone pagou de facto (ficheiro da RUN). */
  AlinhamentoVodafone: 2,
  /** Chargeback por desativação antecipada. */
  Chargeback: 3,
  /** Regras do plano que anulam o comissionamento por completo. */
  AnulacaoComissionamento: 4,
  /** Escape hatch — qualquer outro caso, com motivo. */
  AjusteManual: 5,
  /** Acerto de nível parceiro, sem negócio associado. */
  AjusteParceiro: 6,
  /**
   * Escrito pelo MOTOR quando o apuramento é refeito e o valor muda (botão "Recalcular"
   * ou reprocessamento por webhook). Nunca criado à mão.
   */
  Recalculo: 7,
} as const;

export type TipoAcerto = (typeof TiposAcerto)[keyof typeof TiposAcerto];
