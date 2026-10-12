// Port de tests/.../Vodafone/TrimestralPremiosCalculatorTests.cs: os cenários das
// Figuras 3/4 do plano e as arestas que a fixture real (2026-Q3) não cobre.
import { describe, expect, it } from "vitest";
import {
  type AjustePropriaLinhaInput,
  type ApuramentoContexto,
  calcularPremio,
  contarObjetivosAtingidos,
  type LinhaProdutoInput,
  type ObjetivoTrimestralInput,
} from "@/lib/calculo";
import { d, expectValor } from "./ajuda";

const objetivo = (
  idObjetivo: number,
  idFunilPipedrive: number,
  posicionamento: string,
  pctAtingimento: string,
  atingido: boolean,
): ObjetivoTrimestralInput => ({
  idObjetivo,
  idFunilPipedrive,
  posicionamento: d(posicionamento),
  pctAtingimento: d(pctAtingimento),
  atingido,
});

/** Linha base: RLMC1 GOLD Nova Receita 24m, 1 unidade, RLMC 100€, upfront 6.0. */
const linhaBase = (alteracoes: Partial<LinhaProdutoInput> = {}): LinhaProdutoInput => ({
  idCalculoComissoes: "11111111-1111-1111-1111-111111111111",
  idSysNegocio: "22222222-2222-2222-2222-222222222222",
  idFunilPipedrive: 1,
  idTipoReceita: 1,
  oferta: 1,
  valorUnidade: d(100),
  quantidade: 1,
  upfrontLinha: d("6.0"),
  ajusteDuracao: d("1.0"),
  margemPremioPct: d(0),
  ...alteracoes,
});

/** Faixas da Figura 3, iguais à config da fixture real. */
const faixasPadrao = (): AjustePropriaLinhaInput[] =>
  [
    ["0.7000", "0.7500", "0.4000"],
    ["0.7500", "0.8000", "0.5000"],
    ["0.8000", "0.8500", "0.6000"],
    ["0.8500", "0.9000", "0.7000"],
    ["0.9000", "0.9500", "0.7500"],
    ["0.9500", "1.0000", "0.8000"],
    ["1.0000", "9.9999", "1.0000"],
  ].map(([pctMin, pctMax, ajuste]) => ({ pctMin: d(pctMin), pctMax: d(pctMax), ajuste: d(ajuste) }));

/** Os 5 objetivos a 100% e atingidos; patamar 5 → GOLD Nova = 7.75. */
function contextoTodosA100(objetivoDaLinha?: ObjetivoTrimestralInput): ApuramentoContexto {
  return {
    objetivos: [
      objetivoDaLinha ?? objetivo(1, 1, "1", "1", true),
      objetivo(2, 2, "1", "1", true),
      objetivo(3, 3, "1", "1", true),
      objetivo(4, 4, "1", "1", true),
      objetivo(5, 5, "1", "1", true),
    ],
    planoDoPatamar: [{ tipoReceita: 1, oferta: 1, ponderadorPremio: d("7.75") }],
    ajustesPropriaLinha: faixasPadrao(),
    ajusteCruzado: d(1),
  };
}

function contextoComPosicionamento(posicionamentoLinha: string, ajusteCruzado: string, faixaMaisBaixaMin?: string) {
  const ctx = contextoTodosA100(objetivo(1, 1, posicionamentoLinha, "1", true));
  return {
    ...ctx,
    ajustesPropriaLinha:
      faixaMaisBaixaMin === undefined
        ? faixasPadrao()
        : faixasPadrao().filter((f) => f.pctMin.gte(d(faixaMaisBaixaMin))),
    ajusteCruzado: d(ajusteCruzado),
  };
}

describe("calcularPremio — fator de atingimento (vendas vs acordado)", () => {
  it("abaixo de 90% anula o prémio", () => {
    const r = calcularPremio(linhaBase(), contextoTodosA100(objetivo(1, 1, "1", "0.83", false)));
    expect(r.erro).toBeNull();
    expectValor(r.premioBruto, "0");
    expectValor(r.premioLiquido, "0");
  });

  it("entre 90% e 100% aplica o fator proporcional (175 × 0.95 = 166.25)", () => {
    const r = calcularPremio(linhaBase(), contextoTodosA100(objetivo(1, 1, "1", "0.95", true)));
    expectValor(r.premioBruto, "166.25");
  });

  it("acima de 100% fica no teto de 100%", () => {
    const r = calcularPremio(linhaBase(), contextoTodosA100(objetivo(1, 1, "1", "1.5", true)));
    expectValor(r.premioBruto, "175");
  });
});

describe("calcularPremio — fator de posicionamento (Figuras 3 e 4)", () => {
  it("posicionamento a 100% usa o ajuste cruzado (175 × 0.90 = 157.50)", () => {
    const r = calcularPremio(linhaBase(), contextoComPosicionamento("1", "0.90"));
    expectValor(r.premioBruto, "157.50");
  });

  it("abaixo de 100% usa o ajuste da própria linha: 80% → faixa [0.80, 0.85) → 60%", () => {
    const r = calcularPremio(linhaBase(), contextoComPosicionamento("0.80", "1"));
    expectValor(r.premioBruto, "105.00");
  });

  it("abaixo da menor faixa configurada dá fator 0, sem erro", () => {
    const r = calcularPremio(linhaBase(), contextoComPosicionamento("0.50", "1", "0.70"));
    expect(r.erro).toBeNull();
    expectValor(r.premioBruto, "0");
    expectValor(r.premioLiquido, "0");
  });
});

describe("calcularPremio — margem retida pelo parceiro", () => {
  it("margem null: o parceiro retém tudo e o comercial não recebe (o n8n assumia 0)", () => {
    const r = calcularPremio(linhaBase({ margemPremioPct: null }), contextoTodosA100());
    expectValor(r.premioBruto, "175");
    expectValor(r.premioLiquido, "0");
  });

  it("margem 0 não desconta do bruto", () => {
    const r = calcularPremio(linhaBase({ margemPremioPct: d(0) }), contextoTodosA100());
    expectValor(r.premioBruto, "175");
    expectValor(r.premioLiquido, "175");
  });

  it("margem 50% → líquido = metade do bruto", () => {
    const r = calcularPremio(linhaBase({ margemPremioPct: d(50) }), contextoTodosA100());
    expectValor(r.premioBruto, "175");
    expectValor(r.premioLiquido, "87.50");
  });
});

describe("calcularPremio — arestas", () => {
  it("ajuste de duração null vale 1", () => {
    const r = calcularPremio(linhaBase({ ajusteDuracao: null }), contextoTodosA100());
    expectValor(r.premioBruto, "175");
  });

  it("ponderador < upfront da linha dá prémio negativo (herdado do n8n, de propósito)", () => {
    const ctx: ApuramentoContexto = {
      objetivos: [objetivo(1, 1, "1", "1", true)],
      planoDoPatamar: [{ tipoReceita: 1, oferta: 1, ponderadorPremio: d(5) }],
      ajustesPropriaLinha: faixasPadrao(),
      ajusteCruzado: d(1),
    };
    // upfront 6, ponderador 5 → diferença −1 → 100 × −1 × 1 = −100
    const r = calcularPremio(linhaBase({ upfrontLinha: d(6) }), ctx);
    expectValor(r.premioBruto, "-100");
  });

  it("sem ponderador para a oferta devolve erro tipado", () => {
    const ctx: ApuramentoContexto = {
      objetivos: [objetivo(1, 1, "1", "1", true)],
      planoDoPatamar: [{ tipoReceita: 1, oferta: 1, ponderadorPremio: d("7.75") }],
      ajustesPropriaLinha: faixasPadrao(),
      ajusteCruzado: d(1),
    };
    const r = calcularPremio(linhaBase({ oferta: 99 }), ctx);
    expect(r.erro).toBe("ponderador-nao-encontrado");
    expect(r.premioBruto).toBeNull();
  });

  it("sem objetivo para o funil da linha devolve erro tipado", () => {
    const ctx: ApuramentoContexto = {
      objetivos: [objetivo(1, 1, "1", "1", true)],
      planoDoPatamar: [{ tipoReceita: 1, oferta: 1, ponderadorPremio: d("7.75") }],
      ajustesPropriaLinha: faixasPadrao(),
      ajusteCruzado: d(1),
    };
    const r = calcularPremio(linhaBase({ idFunilPipedrive: 99 }), ctx);
    expect(r.erro).toBe("objetivo-linha-nao-encontrado");
  });
});

describe("contarObjetivosAtingidos", () => {
  it("conta só os atingidos; o posicionamento não entra", () => {
    expect(
      contarObjetivosAtingidos([
        objetivo(1, 1, "1", "1", true),
        objetivo(2, 2, "1", "0.8", false),
        objetivo(3, 3, "1", "1", true),
        objetivo(4, 4, "0.5", "1", true),
        objetivo(5, 5, "1", "0.5", false),
      ]),
    ).toBe(3);
  });
});
