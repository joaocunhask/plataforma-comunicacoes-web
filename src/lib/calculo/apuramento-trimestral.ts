// Apuramento trimestral de uma empresa, sem I/O. Port da lógica de
// API/Services/TrimestralApuramentoService.cs; a leitura e a gravação ficam com quem chama.
//
// O fluxo tem dois passos porque a BD está no meio, como no C#:
//   1. linhasDoTrimestre + realizadoPorFunil → quem chama grava valor_realizado (e
//      data_fecho, só da primeira vez) e relê as colunas geradas (posicionamento,
//      pct_atingimento, atingido);
//   2. apurarPremios com os objetivos relidos → os prémios a gravar e os negócios a
//      passar a PROCESSADO.
//
// Ordem: onde o C# fazia FirstOrDefault sobre uma consulta sem ORDER BY, aqui ganha o
// primeiro da lista. Quem chama deve ordenar (por id) para o resultado ser determinístico.

import { type DataCivil, partesDaData, trimestreDe } from "./datas";
import { NetDecimal } from "./decimal-net";
import { mapaUnico } from "./colecoes";
import { contaParaCalculos, EstadosNegocio } from "./estados-negocio";
import {
  type AjustePropriaLinhaInput,
  type ApuramentoContexto,
  calcularPremio,
  contarObjetivosAtingidos,
  type LinhaPremioErro,
  type ObjetivoTrimestralInput,
  type PlanoComissionalInput,
} from "./premio-trimestral";
import { tryParseIntNet, vazioNet } from "./texto-net";

/** Uma linha de sys_calculo_comissoes com o cabeçalho (sys_negocios) de que o apuramento precisa. */
export interface LinhaParaApuramento {
  id: string;
  idSysNegocio: string;
  dataInicioContrato: DataCivil | null;
  valorUnidade: NetDecimal | null;
  quantidade: number | null;
  upfront: NetDecimal | null;
  /** O id da oferta guardado como texto (convenção herdada do n8n). */
  oferta: string | null;
  ajusteDuracao: NetDecimal | null;
  negocio: {
    id: string;
    estado: string;
    idFunil: string | null;
    idTipoReceita: number | null;
    idComercial: number | null;
  };
}

/** Um objetivo trimestral tal como está na BD depois de gravar o realizado e reler. */
export interface ObjetivoTrimestralDaBd {
  idObjetivo: number;
  /** ref_objetivos.id_funil_pipedrive do objetivo. */
  idFunilPipedrive: number | null;
  posicionamento: NetDecimal | null;
  pctAtingimento: NetDecimal | null;
  atingido: number | null;
}

export function validarTrimestre(trimestre: number): string | null {
  return Number.isInteger(trimestre) && trimestre >= 1 && trimestre <= 4 ? null : "Trimestre inválido (1–4).";
}

/**
 * As linhas que o trimestre apura: negócio ATIVO ou PROCESSADO (lista branca), com data
 * de início, e essa data no ano e trimestre pedidos. ANULADO e EM_VALIDACAO ficam fora.
 */
export function linhasDoTrimestre<L extends LinhaParaApuramento>(linhas: readonly L[], ano: number, trimestre: number): L[] {
  return linhas.filter(
    (l): l is L & { dataInicioContrato: DataCivil } =>
      l.dataInicioContrato !== null &&
      contaParaCalculos(l.negocio.estado) &&
      partesDaData(l.dataInicioContrato).ano === ano &&
      trimestreDe(l.dataInicioContrato) === trimestre,
  );
}

/** valor_realizado por funil: Σ RLMC × quantidade das linhas do trimestre. */
export function realizadoPorFunil(linhasTrimestre: readonly LinhaParaApuramento[]): Map<number, NetDecimal> {
  const porFunil = new Map<number, NetDecimal>();
  for (const l of linhasTrimestre) {
    const funil = tryParseIntNet(l.negocio.idFunil);
    if (funil === null) continue;
    const valor = (l.valorUnidade ?? NetDecimal.ZERO).times(l.quantidade ?? 0);
    porFunil.set(funil, (porFunil.get(funil) ?? NetDecimal.ZERO).plus(valor));
  }
  return porFunil;
}

/** O valor_realizado a gravar num objetivo (0 se o funil não teve vendas). */
export function valorRealizadoDoObjetivo(idFunilPipedrive: number | null, realizado: ReadonlyMap<number, NetDecimal>): NetDecimal {
  return (idFunilPipedrive !== null ? realizado.get(idFunilPipedrive) : undefined) ?? NetDecimal.ZERO;
}

export type ErroLinhaApuramento = "id-funil-invalido" | "oferta-invalida" | "sem-tipo-receita" | LinhaPremioErro;

export interface ResultadoApuramentoTrimestral {
  /** Nº de objetivos atingidos (o patamar do plano). */
  objetivosAtingidos: number;
  /** Prémios a gravar, pela ordem das linhas. */
  premios: { idCalculo: string; premiosBruto: NetDecimal; premiosLiquido: NetDecimal }[];
  /** Linhas sem prémio (não se grava nada nelas). */
  semPremio: { idCalculo: string; erro: ErroLinhaApuramento }[];
  /** Negócios ATIVO apurados, a passar a PROCESSADO (ANULADO/PROCESSADO ficam como estão). */
  negociosAProcessar: string[];
}

export function apurarPremios(params: {
  /** Os objetivos do trimestre, relidos depois de gravar o realizado. Ordenar por id. */
  objetivos: readonly ObjetivoTrimestralDaBd[];
  /** O resultado de linhasDoTrimestre. */
  linhasTrimestre: readonly LinhaParaApuramento[];
  /** ref_plano_comissional_vodafone da empresa, todos os patamares. */
  planoComissional: readonly (PlanoComissionalInput & { objetivosAtingidos: number | null })[];
  /** ref_ajuste_comissao_propria_linha_vodafone da empresa. */
  ajustesPropriaLinha: readonly AjustePropriaLinhaInput[];
  /** ref_ajuste_comissao_cruzado_vodafone da empresa. */
  ajustesCruzados: readonly { nrLinhasAbaixo100: number; ajuste: NetDecimal }[];
  /** org_membros da empresa. */
  membros: readonly { idCrm: string | null; aspnetUserId: string; bloqueado: boolean }[];
  /** cfg_margens ativas de tipo "premio" da empresa, na operadora Vodafone. */
  margensPremio: readonly { aspnetUserId: string; margemPercentagem: NetDecimal }[];
}): ResultadoApuramentoTrimestral {
  const objetivos: ObjetivoTrimestralInput[] = params.objetivos.map((o) => ({
    idObjetivo: o.idObjetivo,
    idFunilPipedrive: o.idFunilPipedrive ?? 0,
    posicionamento: o.posicionamento ?? NetDecimal.UM,
    pctAtingimento: o.pctAtingimento ?? NetDecimal.ZERO,
    atingido: (o.atingido ?? 0) === 1,
  }));

  const patamar = contarObjetivosAtingidos(objetivos);
  const nrLinhasAbaixo100 = objetivos.filter((o) => o.posicionamento.lt(NetDecimal.UM)).length;
  const ctx: ApuramentoContexto = {
    objetivos,
    planoDoPatamar: params.planoComissional.filter((p) => p.objetivosAtingidos === patamar),
    ajustesPropriaLinha: params.ajustesPropriaLinha,
    ajusteCruzado: params.ajustesCruzados.find((a) => a.nrLinhasAbaixo100 === nrLinhasAbaixo100)?.ajuste ?? NetDecimal.UM,
  };

  // Margem de prémio por comercial (id_crm → aspnet_user_id → cfg_margens). Um comercial
  // bloqueado fica fora do mapa → margem null → líquido 0; as linhas dele continuam a
  // contar para o atingimento (o contrato é da empresa).
  const userIdPorCrm = mapaUnico(
    params.membros.flatMap((m) => {
      if (m.bloqueado || vazioNet(m.idCrm)) return [];
      const idCrm = tryParseIntNet(m.idCrm);
      return idCrm === null ? [] : [{ idCrm, aspnetUserId: m.aspnetUserId }];
    }),
    (m) => m.idCrm,
    (m) => m.aspnetUserId,
  );
  const margemPorUser = mapaUnico(params.margensPremio, (m) => m.aspnetUserId, (m) => m.margemPercentagem);

  const resultado: ResultadoApuramentoTrimestral = {
    objetivosAtingidos: patamar,
    premios: [],
    semPremio: [],
    negociosAProcessar: [],
  };

  for (const c of params.linhasTrimestre) {
    const neg = c.negocio;
    const idFunil = tryParseIntNet(neg.idFunil);
    if (idFunil === null) {
      resultado.semPremio.push({ idCalculo: c.id, erro: "id-funil-invalido" });
      continue;
    }
    const oferta = tryParseIntNet(c.oferta);
    if (oferta === null) {
      resultado.semPremio.push({ idCalculo: c.id, erro: "oferta-invalida" });
      continue;
    }
    if (neg.idTipoReceita === null) {
      resultado.semPremio.push({ idCalculo: c.id, erro: "sem-tipo-receita" });
      continue;
    }

    const userId = neg.idComercial !== null ? userIdPorCrm.get(neg.idComercial) : undefined;
    const margem = userId !== undefined ? (margemPorUser.get(userId) ?? null) : null;

    const r = calcularPremio(
      {
        idCalculoComissoes: c.id,
        idSysNegocio: c.idSysNegocio,
        idFunilPipedrive: idFunil,
        idTipoReceita: neg.idTipoReceita,
        oferta,
        valorUnidade: c.valorUnidade ?? NetDecimal.ZERO,
        quantidade: c.quantidade ?? 0,
        upfrontLinha: c.upfront ?? NetDecimal.ZERO,
        ajusteDuracao: c.ajusteDuracao,
        margemPremioPct: margem,
      },
      ctx,
    );

    if (r.erro !== null) resultado.semPremio.push({ idCalculo: c.id, erro: r.erro });
    else resultado.premios.push({ idCalculo: c.id, premiosBruto: r.premioBruto, premiosLiquido: r.premioLiquido });
  }

  // Negócios apurados que estavam ATIVO passam a PROCESSADO (uma vez cada, pela ordem).
  const vistos = new Set<string>();
  for (const c of params.linhasTrimestre) {
    if (vistos.has(c.negocio.id)) continue;
    vistos.add(c.negocio.id);
    if (c.negocio.estado === EstadosNegocio.Ativo) resultado.negociosAProcessar.push(c.negocio.id);
  }

  return resultado;
}
