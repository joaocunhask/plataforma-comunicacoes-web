// O motor TypeScript contra o motor C#: cada caso de casos-net.json foi calculado pelo
// código C# de produção (ferramentas/oraculo-net). Compara-se o TEXTO dos decimais, não
// só o valor — "600.00" e "600" são o mesmo número mas não o mesmo que se grava.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aplicarMargemDoComercial,
  balde,
  calcularPremio,
  calcularUpfront,
  comercialDerivado,
  contarObjetivosAtingidos,
  dataCivil,
  lerSubscricoes,
  NetDecimal,
  ObservacoesInvalidasError,
  parseTipoPeriodo,
  planearFecho,
  planearMargens,
  raciosComercial,
  resolverPatamar,
  type TipoPeriodoPatamar,
  toUpperInvariantNet,
  trimNet,
  tryParseIntNet,
  vazioOuEspacosNet,
} from "@/lib/calculo";

/* eslint-disable @typescript-eslint/no-explicit-any -- casos lidos de JSON */
type Caso = any;

const oraculo: { seccoes: Record<string, Caso[]> } = JSON.parse(
  readFileSync(join(__dirname, "casos-net.json"), "utf8"),
);

const dec = (s: string) => NetDecimal.de(s);
const decN = (s: string | null) => (s === null ? null : NetDecimal.de(s));
const str = (d: NetDecimal | null) => (d === null ? null : d.toString());

/** Corre todos os casos de uma secção e falha com os primeiros que divergem. */
function verificarSeccao(nome: string, verificar: (caso: Caso) => unknown, esperado: (caso: Caso) => unknown) {
  it(`${nome}: bate com o C# em todos os casos`, () => {
    const casos = oraculo.seccoes[nome];
    expect(casos.length).toBeGreaterThan(0);
    const divergencias: unknown[] = [];
    for (const caso of casos) {
      let obtido: unknown;
      try {
        obtido = verificar(caso);
      } catch (e) {
        obtido = { lancou: (e as Error).name };
      }
      const esperadoCaso = esperado(caso);
      if (JSON.stringify(obtido) !== JSON.stringify(esperadoCaso)) {
        divergencias.push({ caso, obtido, esperado: esperadoCaso });
        if (divergencias.length >= 5) break;
      }
    }
    expect(divergencias).toEqual([]);
  });
}

describe("oráculo .NET", () => {
  verificarSeccao(
    "aritmetica",
    (c) => {
      const a = dec(c.a);
      const b = dec(c.b);
      try {
        switch (c.op) {
          case "div":
            return a.div(b).toString();
          case "mul":
            return a.times(b).toString();
          case "add":
            return a.plus(b).toString();
          case "sub":
            return a.minus(b).toString();
          case "round2afz":
            return a.round(2).toString();
          case "round2even":
            return a.round(2, "ao-par").toString();
          case "round0afz":
            return a.round(0).toString();
          case "min":
            return NetDecimal.min(a, b).toString();
          case "cmp":
            return String(a.cmp(b));
        }
      } catch (e) {
        if (e instanceof RangeError) return "overflow";
        throw e;
      }
      throw new Error(`op desconhecida ${c.op}`);
    },
    (c) => c.r,
  );

  verificarSeccao(
    "upfront",
    (c) => {
      const r = calcularUpfront({
        valorUnidade: dec(c.valorUnidade),
        quantidade: c.quantidade,
        upfrontPlano: dec(c.upfrontPlano),
        ajusteDuracao: dec(c.ajusteDuracao),
        margemUpfrontPct: decN(c.margemUpfrontPct),
      });
      return [r.valorBruto.toString(), r.valorLiquido.toString()];
    },
    (c) => [c.bruto, c.liquido],
  );

  const ERROS_PREMIO: Record<string, string> = {
    PonderadorNaoEncontrado: "ponderador-nao-encontrado",
    ObjetivoLinhaNaoEncontrado: "objetivo-linha-nao-encontrado",
  };
  verificarSeccao(
    "premio",
    (c) => {
      // No ficheiro em arrays: [id, funil, posicionamento, pct, atingido].
      const objetivos = c.objetivos.map(([idObjetivo, idFunilPipedrive, posicionamento, pct, atingido]: Caso) => ({
        idObjetivo,
        idFunilPipedrive,
        posicionamento: dec(posicionamento),
        pctAtingimento: dec(pct),
        atingido,
      }));
      const r = calcularPremio(
        {
          idCalculoComissoes: "linha",
          idSysNegocio: "negocio",
          idFunilPipedrive: c.linha.idFunilPipedrive,
          idTipoReceita: c.linha.idTipoReceita,
          oferta: c.linha.oferta,
          valorUnidade: dec(c.linha.valorUnidade),
          quantidade: c.linha.quantidade,
          upfrontLinha: dec(c.linha.upfrontLinha),
          ajusteDuracao: decN(c.linha.ajusteDuracao),
          margemPremioPct: decN(c.linha.margemPremioPct),
        },
        {
          objetivos,
          planoDoPatamar: c.plano.map(([tipoReceita, oferta, ponderador]: Caso) => ({
            tipoReceita,
            oferta,
            ponderadorPremio: dec(ponderador),
          })),
          ajustesPropriaLinha: c.faixas.map(([pctMin, pctMax, ajuste]: Caso) => ({
            pctMin: dec(pctMin),
            pctMax: dec(pctMax),
            ajuste: dec(ajuste),
          })),
          ajusteCruzado: dec(c.ajusteCruzado),
        },
      );
      return [contarObjetivosAtingidos(objetivos), str(r.premioBruto), str(r.premioLiquido), r.erro];
    },
    (c) => [c.objetivosAtingidos, c.bruto, c.liquido, c.erro === null ? null : ERROS_PREMIO[c.erro]],
  );

  const escada = (c: Caso) =>
    c.escada.map((e: Caso) => ({
      ordem: e.ordem,
      limiteInferior: dec(e.limiteInferior),
      percentagemComercial: dec(e.percentagemComercial),
    }));
  const linhas = (c: Caso) =>
    c.linhas.map((l: Caso) => ({ dataInicioContrato: dataCivil(l.dataInicioContrato), valorUpfrontBruto: dec(l.valorUpfrontBruto) }));

  verificarSeccao(
    "patamarResolver",
    (c) => {
      const e = resolverPatamar(escada(c), dec(c.acumulado));
      return [e?.ordem ?? null, str(e?.limiteInferior ?? null), str(e?.percentagemComercial ?? null)];
    },
    (c) => [c.ordem, c.limiteInferior, c.percentagemComercial],
  );

  verificarSeccao(
    "balde",
    (c) => {
      const p = balde(dataCivil(c.data), c.tipo as TipoPeriodoPatamar);
      return [p.inicio, p.fim];
    },
    (c) => [c.inicio, c.fim],
  );

  verificarSeccao(
    "parseTipoPeriodo",
    (c) => {
      try {
        return parseTipoPeriodo(c.codigo);
      } catch {
        return null;
      }
    },
    (c) => c.tipo,
  );

  verificarSeccao(
    "margemPlanner",
    (c) => {
      const carimbos = new Map(c.carimbos.map((k: Caso) => [dataCivil(k.inicio), dec(k.percentagem)] as const));
      const plano = planearMargens(linhas(c), c.tipo, escada(c), carimbos as Map<never, NetDecimal>, dataCivil(c.hoje));
      return {
        porPeriodo: [...plano.porPeriodo].map(([inicio, p]) => ({
          inicio,
          fim: p.periodo.fim,
          acumulado: p.acumulado.toString(),
          margem: str(p.margem),
          fechado: p.fechado,
        })),
        margens: c.margens.map((m: Caso) => ({ data: m.data, margem: str(plano.margemPara(dataCivil(m.data))) })),
      };
    },
    (c) => ({ porPeriodo: c.porPeriodo, margens: c.margens }),
  );

  verificarSeccao(
    "fechoPlanner",
    (c) =>
      planearFecho(
        linhas(c),
        c.tipo,
        escada(c),
        new Set(c.jaCarimbados.map(dataCivil)),
        dataCivil(c.hoje),
        dataCivil(c.desde),
      ).map((k) => ({
        inicio: k.periodo.inicio,
        fim: k.periodo.fim,
        acumulado: k.acumulado.toString(),
        ordem: k.ordem,
        percentagemComercial: k.percentagemComercial.toString(),
      })),
    (c) => c.carimbos,
  );

  verificarSeccao(
    "liquidoPatamar",
    (c) => aplicarMargemDoComercial(dec(c.bruto), dec(c.margem)).toString(),
    (c) => c.liquido,
  );

  verificarSeccao(
    "acertoDerivado",
    (c) => {
      const racio = raciosComercial(
        [
          {
            idSysNegocio: "n",
            operadoraId: 1,
            dataInicioContrato: null,
            valorUpfrontBruto: dec(c.upBruto),
            valorUpfrontLiquido: dec(c.upLiq),
            premiosBruto: dec(c.premBruto),
            premiosLiquido: dec(c.premLiq),
            idComercial: null,
          },
        ],
        new Map(),
      ).get("n")!;
      const comercial = comercialDerivado(
        { deltaUpfrontBruto: decN(c.deltaUpfrontBruto), deltaPremioBruto: decN(c.deltaPremioBruto) },
        racio,
      );
      return [racio.up.toString(), racio.prem.toString(), comercial.toString()];
    },
    (c) => [c.racioUp, c.racioPrem, c.comercial],
  );

  verificarSeccao(
    "intTryParse",
    (c) => tryParseIntNet(c.texto),
    (c) => c.valor,
  );

  verificarSeccao(
    "texto",
    (c) => [trimNet(c.texto), vazioOuEspacosNet(c.texto), toUpperInvariantNet(c.texto)],
    (c) => [c.trim, c.branco, c.maiusculas],
  );

  verificarSeccao(
    "observacoes",
    (c) => {
      try {
        return { subscricoes: lerSubscricoes(c.texto) };
      } catch (e) {
        if (e instanceof ObservacoesInvalidasError) return { erro: "FormatException" };
        throw e;
      }
    },
    (c) => c.resultado,
  );
});
