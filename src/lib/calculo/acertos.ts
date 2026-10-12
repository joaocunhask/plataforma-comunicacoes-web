// O valor para o comercial dos acertos manuais, sem I/O. Port da parte de cálculo de
// API/Services/AcertosService.cs (RaciosComercialAsync, ComercialDerivado e
// AgregarPorNegocioAsync).
//
// Um acerto SEM override (delta_liquido null) não guarda o valor do comercial: deriva-o do
// rácio comercial/bruto do negócio, que já reflete as duas semânticas de margem (upfront
// pelo patamar ou pelo guardado; prémio pelo guardado). As divisões do rácio usam o
// decimal do .NET (28 casas, ao par) — é isso que faz o cêntimo final bater.

import type { DataCivil } from "./datas";
import { NetDecimal } from "./decimal-net";
import { aplicarMargemDoComercial, type PlanoMargensComercial } from "./patamares";
import { TiposAcerto } from "./tipos-acerto";

/** Uma linha de sys_calculo_comissoes com o comercial do negócio. */
export interface LinhaParaRacio {
  idSysNegocio: string;
  operadoraId: number;
  dataInicioContrato: DataCivil | null;
  valorUpfrontBruto: NetDecimal | null;
  valorUpfrontLiquido: NetDecimal | null;
  premiosBruto: NetDecimal | null;
  premiosLiquido: NetDecimal | null;
  /** sys_negocios.id_comercial. */
  idComercial: number | null;
}

export interface RacioComercial {
  up: NetDecimal;
  prem: NetDecimal;
}

const RACIO_ZERO: RacioComercial = { up: NetDecimal.ZERO, prem: NetDecimal.ZERO };

/**
 * Rácio comercial/bruto (upfront e prémio) de cada negócio. O plano de patamares do
 * negócio é o do comercial da PRIMEIRA linha, procurado por id_crm exato
 * (idComercial.toString()) em `planoPorIdCrm`.
 */
export function raciosComercial(
  linhas: readonly LinhaParaRacio[],
  planoPorIdCrm: ReadonlyMap<string, PlanoMargensComercial>,
): Map<string, RacioComercial> {
  const porNegocio = new Map<string, LinhaParaRacio[]>();
  for (const l of linhas) {
    const grupo = porNegocio.get(l.idSysNegocio);
    if (grupo) grupo.push(l);
    else porNegocio.set(l.idSysNegocio, [l]);
  }

  const racios = new Map<string, RacioComercial>();
  for (const [negocioId, grupo] of porNegocio) {
    const idComercial = grupo[0].idComercial;
    const plano = idComercial === null ? undefined : planoPorIdCrm.get(String(idComercial));

    let upBruto = NetDecimal.ZERO;
    let upLiq = NetDecimal.ZERO;
    let premBruto = NetDecimal.ZERO;
    let premLiq = NetDecimal.ZERO;
    for (const l of grupo) {
      const bruto = l.valorUpfrontBruto ?? NetDecimal.ZERO;
      upBruto = upBruto.plus(bruto);
      premBruto = premBruto.plus(l.premiosBruto ?? NetDecimal.ZERO);
      premLiq = premLiq.plus(l.premiosLiquido ?? NetDecimal.ZERO);

      let upLiqLinha = l.valorUpfrontLiquido ?? NetDecimal.ZERO; // guardado (cfg_margens) por omissão
      if (plano?.ativo && l.dataInicioContrato !== null) {
        const m = plano.margemPara(l.operadoraId, l.dataInicioContrato);
        if (m !== null) upLiqLinha = aplicarMargemDoComercial(bruto, m);
      }
      upLiq = upLiq.plus(upLiqLinha);
    }

    racios.set(negocioId, {
      up: upBruto.isZero() ? NetDecimal.ZERO : upLiq.div(upBruto),
      prem: premBruto.isZero() ? NetDecimal.ZERO : premLiq.div(premBruto),
    });
  }
  return racios;
}

/** O valor do comercial de um acerto SEM override, pelo rácio do negócio. */
export function comercialDerivado(
  acerto: { deltaUpfrontBruto: NetDecimal | null; deltaPremioBruto: NetDecimal | null },
  racio: RacioComercial,
): NetDecimal {
  return (acerto.deltaUpfrontBruto ?? NetDecimal.ZERO)
    .times(racio.up)
    .plus((acerto.deltaPremioBruto ?? NetDecimal.ZERO).times(racio.prem))
    .round(2);
}

export interface AcertoParaAgregar {
  idSysNegocio: string;
  idTipoAcerto: number;
  deltaBruto: NetDecimal;
  /** Override do comercial; null → derivado do rácio. */
  deltaLiquido: NetDecimal | null;
  deltaUpfrontBruto: NetDecimal | null;
  deltaPremioBruto: NetDecimal | null;
  /** criado_em em microssegundos desde a época (a precisão da coluna). */
  criadoEmMicros: bigint;
}

export interface AgregadoAcertos {
  n: number;
  bruto: NetDecimal;
  /** Total do comercial EFETIVO (override ou derivado). */
  liquido: NetDecimal;
  /** Overrides anteriores ao último RECALCULO (os derivados nunca ficam desatualizados). */
  desatualizados: number;
}

/** Agregado de acertos por negócio, para o painel Admin. */
export function agregarAcertosPorNegocio(
  acertos: readonly AcertoParaAgregar[],
  racios: ReadonlyMap<string, RacioComercial>,
): Map<string, AgregadoAcertos> {
  const porNegocio = new Map<string, AcertoParaAgregar[]>();
  for (const a of acertos) {
    const grupo = porNegocio.get(a.idSysNegocio);
    if (grupo) grupo.push(a);
    else porNegocio.set(a.idSysNegocio, [a]);
  }

  const resultado = new Map<string, AgregadoAcertos>();
  for (const [negocioId, grupo] of porNegocio) {
    const racio = racios.get(negocioId) ?? RACIO_ZERO;
    let ultimoRecalculo: bigint | null = null;
    for (const a of grupo) {
      if (a.idTipoAcerto === TiposAcerto.Recalculo && (ultimoRecalculo === null || a.criadoEmMicros > ultimoRecalculo)) {
        ultimoRecalculo = a.criadoEmMicros;
      }
    }

    const agregado: AgregadoAcertos = { n: 0, bruto: NetDecimal.ZERO, liquido: NetDecimal.ZERO, desatualizados: 0 };
    for (const a of grupo) {
      agregado.n++;
      agregado.bruto = agregado.bruto.plus(a.deltaBruto);
      agregado.liquido = agregado.liquido.plus(a.deltaLiquido ?? comercialDerivado(a, racio));
      if (
        a.deltaLiquido !== null &&
        (!a.deltaBruto.isZero() || !a.deltaLiquido.isZero()) &&
        ultimoRecalculo !== null &&
        a.criadoEmMicros < ultimoRecalculo
      ) {
        agregado.desatualizados++;
      }
    }
    resultado.set(negocioId, agregado);
  }
  return resultado;
}
