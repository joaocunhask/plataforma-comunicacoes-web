// Estados de sys_negocios.estado e as regras que dependem deles, num sítio só.
// Port de Shared/Negocios/EstadosNegocio.cs.
//
// Lista BRANCA: só os estados de contaParaCalculos entram no atingimento, no prémio e nos
// patamares. Um estado novo fica de fora até ser acrescentado aqui de propósito.

export const EstadosNegocio = {
  /** Ganho e ainda não apurado no trimestral. Editável. */
  Ativo: "ATIVO",
  /**
   * Ganho no Pipedrive mas à espera de validação da Vodafone, sem data de início real.
   * Não conta para o atingimento, o prémio, nem os patamares; o apuramento trimestral
   * não o passa a PROCESSADO. Editável (é preciso pôr a data real para o ativar).
   */
  EmValidacao: "EM_VALIDACAO",
  /** Apurado no trimestral (só o motor lá chega). Terminal, read-only. */
  Processado: "PROCESSADO",
  /** Anulado pelo admin. Não conta e fica escondido do comercial. */
  Anulado: "ANULADO",
} as const;

export type EstadoNegocio = (typeof EstadosNegocio)[keyof typeof EstadosNegocio];

/** Os estados que o admin pode escolher no painel. */
export const ESTADOS_MANUAIS_NO_PAINEL: readonly EstadoNegocio[] = [
  EstadosNegocio.Ativo,
  EstadosNegocio.EmValidacao,
  EstadosNegocio.Anulado,
];

/** Estados cujas linhas entram no atingimento, prémio e patamares. */
export function contaParaCalculos(estado: string | null | undefined): boolean {
  return estado === EstadosNegocio.Ativo || estado === EstadosNegocio.Processado;
}

/** Estados em que os campos do negócio e das linhas se editam no painel. */
export function editavel(estado: string | null | undefined): boolean {
  return estado === EstadosNegocio.Ativo || estado === EstadosNegocio.EmValidacao;
}
