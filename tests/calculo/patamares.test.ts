// Port de tests/.../Patamares (PatamarResolverTests, PatamarMargemPlannerTests,
// PatamarFechoPlannerTests) + a parte sem I/O de PatamaresService e PatamaresFechoService.
import { describe, expect, it } from "vitest";
import {
  balde,
  type DataCivil,
  type LinhaBrutoPeriodo,
  liquidoUpfrontExibido,
  NetDecimal,
  type PatamarEscalao,
  parseTipoPeriodo,
  planearFecho,
  planearFechoDaEmpresa,
  planearMargens,
  planearMargensDoComercial,
  PlanoMargensComercial,
  resolverPatamar,
  resolverPercentagem,
  type TipoPeriodoPatamar,
} from "@/lib/calculo";
import { d, data, expectValor } from "./ajuda";

const degrau = (ordem: number, limite: string | number, pct: string | number): PatamarEscalao => ({
  ordem,
  limiteInferior: d(limite),
  percentagemComercial: d(pct),
});
/** Escada standard do exemplo (% que o comercial recebe, progressiva). */
const escada = () => [degrau(1, 0, 80), degrau(2, 1000, 90), degrau(3, 2000, 95)];
const linha = (dataInicio: string, bruto: string | number): LinhaBrutoPeriodo => ({
  dataInicioContrato: data(dataInicio),
  valorUpfrontBruto: d(bruto),
});
const semCarimbos = new Map<DataCivil, NetDecimal>();

describe("balde (período civil de uma data)", () => {
  it.each([
    ["2026-02-15", "MENSAL", "2026-02-01", "2026-02-28"],
    ["2024-02-10", "MENSAL", "2024-02-01", "2024-02-29"],
    ["2026-12-31", "MENSAL", "2026-12-01", "2026-12-31"],
    ["2026-01-01", "MENSAL", "2026-01-01", "2026-01-31"],
    ["2026-02-15", "TRIMESTRAL", "2026-01-01", "2026-03-31"],
    ["2026-03-31", "TRIMESTRAL", "2026-01-01", "2026-03-31"],
    ["2026-04-01", "TRIMESTRAL", "2026-04-01", "2026-06-30"],
    ["2026-11-20", "TRIMESTRAL", "2026-10-01", "2026-12-31"],
    ["2026-07-10", "ANUAL", "2026-01-01", "2026-12-31"],
  ])("%s em %s → [%s, %s]", (dataTexto, tipo, inicio, fim) => {
    expect(balde(data(dataTexto), tipo as TipoPeriodoPatamar)).toEqual({ inicio, fim });
  });
});

describe("resolverPatamar (cliff)", () => {
  it.each([
    [0, 80], // exatamente no limite do primeiro degrau
    [500, 80],
    ["999.99", 80], // um cêntimo abaixo da fronteira
    [1000, 90], // a fronteira é inclusiva no limite inferior
    [1500, 90],
    [2000, 95],
    [9999, 95], // acima de todos → o degrau mais alto
  ])("acumulado %s → %s%%", (acumulado, pct) => {
    expectValor(resolverPercentagem(escada(), d(acumulado)), pct);
  });

  it("abaixo do primeiro degrau usa o primeiro degrau (o chão, nunca a base)", () => {
    expectValor(resolverPercentagem([degrau(1, 500, 80), degrau(2, 1500, 90)], d(100)), 80);
  });

  it("sem degraus devolve null (quem chama usa a margem base)", () => {
    expect(resolverPatamar([], d(5000))).toBeNull();
  });

  it("ignora a ordem de entrada", () => {
    expectValor(resolverPercentagem([degrau(3, 2000, 95), degrau(1, 0, 80), degrau(2, 1000, 90)], d(1500)), 90);
  });

  it("empate de limites desempata pela maior ordem", () => {
    expectValor(resolverPercentagem([degrau(2, 1000, 90), degrau(3, 1000, 92)], d(1500)), 92);
  });

  it("abaixo de todos, com empate no limite, escolhe a menor ordem", () => {
    expectValor(resolverPercentagem([degrau(2, 10, 8), degrau(1, 10, 5)], d(3)), 5);
  });

  it("devolve o degrau completo", () => {
    const e = resolverPatamar(escada(), d(2500));
    expect(e?.ordem).toBe(3);
    expectValor(e?.limiteInferior, 2000);
    expectValor(e?.percentagemComercial, 95);
  });
});

describe("parseTipoPeriodo", () => {
  it.each([
    ["MENSAL", "MENSAL"],
    ["trimestral", "TRIMESTRAL"],
    ["  Anual  ", "ANUAL"],
  ])("%s → %s", (codigo, esperado) => {
    expect(parseTipoPeriodo(codigo)).toBe(esperado);
  });

  it("rejeita códigos inválidos", () => {
    expect(() => parseTipoPeriodo("SEMANAL")).toThrow(RangeError);
  });
});

describe("planearMargens", () => {
  it("período aberto: soma o bruto e resolve o degrau (600+700+900 = 2200 → 95%)", () => {
    const plano = planearMargens(
      [linha("2026-01-03", 600), linha("2026-01-10", 700), linha("2026-01-20", 900)],
      "MENSAL",
      escada(),
      semCarimbos,
      data("2026-01-25"),
    );
    expectValor(plano.margemPara(data("2026-01-03")), 95);
    expectValor(plano.margemPara(data("2026-01-20")), 95);
    const jan = plano.porPeriodo.get(data("2026-01-01"))!;
    expectValor(jan.acumulado, 2200);
    expect(jan.fechado).toBe(false);
  });

  it("períodos diferentes decidem por vias diferentes (Jan fechado → carimbo, Fev aberto → ao vivo)", () => {
    const plano = planearMargens(
      [linha("2026-01-15", 500), linha("2026-02-15", 1500)],
      "MENSAL",
      escada(),
      new Map([[data("2026-01-01"), d(80)]]),
      data("2026-02-20"),
    );
    expectValor(plano.margemPara(data("2026-01-15")), 80);
    expectValor(plano.margemPara(data("2026-02-15")), 90);
  });

  it("período aberto abaixo do primeiro degrau usa o primeiro degrau", () => {
    const plano = planearMargens([linha("2026-01-10", 100)], "MENSAL", [degrau(1, 500, 80)], semCarimbos, data("2026-01-15"));
    expectValor(plano.margemPara(data("2026-01-10")), 80);
  });

  it("período fechado usa o carimbo e ignora o acumulado atual", () => {
    const plano = planearMargens(
      [linha("2026-01-10", 2500)],
      "MENSAL",
      escada(),
      new Map([[data("2026-01-01"), d(88)]]),
      data("2026-02-01"),
    );
    const jan = plano.porPeriodo.get(data("2026-01-01"))!;
    expect(jan.fechado).toBe(true);
    expectValor(plano.margemPara(data("2026-01-10")), 88);
    expectValor(jan.acumulado, 2500); // calculado na mesma (auditoria)
  });

  it("período fechado sem carimbo devolve null (cai no líquido guardado)", () => {
    const plano = planearMargens([linha("2026-01-10", 1500)], "MENSAL", escada(), semCarimbos, data("2026-02-01"));
    expect(plano.margemPara(data("2026-01-10"))).toBeNull();
    expect(plano.porPeriodo.get(data("2026-01-01"))!.fechado).toBe(true);
  });

  it("no último dia do período ainda está aberto", () => {
    const plano = planearMargens([linha("2026-01-10", 1500)], "MENSAL", escada(), semCarimbos, data("2026-01-31"));
    expect(plano.porPeriodo.get(data("2026-01-01"))!.fechado).toBe(false);
    expectValor(plano.margemPara(data("2026-01-10")), 90);
  });

  it("sem linhas dá plano vazio", () => {
    const plano = planearMargens([], "MENSAL", escada(), semCarimbos, data("2026-01-15"));
    expect(plano.porPeriodo.size).toBe(0);
    expect(plano.margemPara(data("2026-01-10"))).toBeNull();
  });

  it("trimestral agrupa os três meses (800+700+600 = 2100 → 95%)", () => {
    const plano = planearMargens(
      [linha("2026-01-31", 800), linha("2026-02-15", 700), linha("2026-03-10", 600)],
      "TRIMESTRAL",
      escada(),
      semCarimbos,
      data("2026-02-01"),
    );
    expect(plano.porPeriodo.size).toBe(1);
    expectValor(plano.porPeriodo.get(data("2026-01-01"))!.acumulado, 2100);
    expectValor(plano.margemPara(data("2026-03-10")), 95);
  });
});

describe("planearFecho", () => {
  const sempre = data("2000-01-01");
  const nada = new Set<DataCivil>();

  it("período fechado gera carimbo com o patamar atingido", () => {
    const carimbos = planearFecho(
      [linha("2026-01-05", 600), linha("2026-01-20", 900)],
      "MENSAL",
      escada(),
      nada,
      data("2026-02-10"),
      sempre,
    );
    expect(carimbos).toHaveLength(1);
    expect(carimbos[0].periodo).toEqual({ inicio: "2026-01-01", fim: "2026-01-31" });
    expectValor(carimbos[0].acumulado, 1500);
    expect(carimbos[0].ordem).toBe(2);
    expectValor(carimbos[0].percentagemComercial, 90);
  });

  it("período ainda aberto não gera carimbo", () => {
    expect(planearFecho([linha("2026-01-10", 1500)], "MENSAL", escada(), nada, data("2026-01-20"), sempre)).toEqual([]);
  });

  it("período já carimbado não gera outro", () => {
    const ja = new Set([data("2026-01-01")]);
    expect(planearFecho([linha("2026-01-10", 1500)], "MENSAL", escada(), ja, data("2026-02-10"), sempre)).toEqual([]);
  });

  it("período antes de `desde` não gera carimbo (pré-ativação)", () => {
    expect(
      planearFecho([linha("2026-01-10", 1500)], "MENSAL", escada(), nada, data("2026-03-10"), data("2026-02-01")),
    ).toEqual([]);
  });

  it("acumulado abaixo do primeiro degrau carimba no primeiro degrau", () => {
    const carimbos = planearFecho([linha("2026-01-10", 100)], "MENSAL", [degrau(1, 500, 80)], nada, data("2026-02-10"), sempre);
    expect(carimbos).toHaveLength(1);
    expect(carimbos[0].ordem).toBe(1);
    expectValor(carimbos[0].percentagemComercial, 80);
    expectValor(carimbos[0].acumulado, 100);
  });

  it("sem escada não gera carimbo", () => {
    expect(planearFecho([linha("2026-01-10", 1500)], "MENSAL", [], nada, data("2026-02-10"), sempre)).toEqual([]);
  });

  it("fecha vários períodos terminados de uma vez (Mar ainda aberto)", () => {
    const carimbos = planearFecho(
      [linha("2026-01-10", 500), linha("2026-02-10", 1500), linha("2026-03-10", 2500)],
      "MENSAL",
      escada(),
      nada,
      data("2026-03-15"),
      sempre,
    );
    expect(carimbos.map((c) => [c.periodo.inicio, c.percentagemComercial.toString()])).toEqual([
      ["2026-01-01", "80"],
      ["2026-02-01", "90"],
    ]);
  });
});

describe("planearMargensDoComercial (PatamaresService sem a BD)", () => {
  const config = { ativo: true, tipoPeriodo: "MENSAL", vigenteDesde: null, criadoEm: data("2026-01-01") };

  it("empresa sem config ativa: plano inativo, margem sempre null", () => {
    const plano = planearMargensDoComercial({
      config: { ...config, ativo: false },
      escaloesAtivos: [],
      carimbos: [],
      linhas: [{ operadoraId: 1, dataInicioContrato: data("2026-01-10"), valorUpfrontBruto: d(1500) }],
      hoje: data("2026-01-15"),
    });
    expect(plano.ativo).toBe(false);
    expect(plano.margemPara(1, data("2026-01-10"))).toBeNull();
  });

  it("um plano por operadora; linhas sem data ficam de fora; escada para o progresso", () => {
    const plano = planearMargensDoComercial({
      config,
      escaloesAtivos: [
        { operadoraId: 1, ...degrau(1, 0, 80) },
        { operadoraId: 1, ...degrau(2, 1000, 90) },
        { operadoraId: 2, ...degrau(1, 0, 50) },
      ],
      carimbos: [],
      linhas: [
        { operadoraId: 1, dataInicioContrato: data("2026-01-10"), valorUpfrontBruto: d(600) },
        { operadoraId: 1, dataInicioContrato: data("2026-01-12"), valorUpfrontBruto: d(600) },
        { operadoraId: 1, dataInicioContrato: null, valorUpfrontBruto: d(5000) },
      ],
      hoje: data("2026-01-15"),
    });
    expect(plano.ativo).toBe(true);
    expectValor(plano.margemPara(1, data("2026-01-10")), 90); // 1200 → degrau 2
    expect(plano.margemPara(2, data("2026-01-10"))).toBeNull(); // sem linhas da operadora 2
    expect([...plano.escadaPorOperadora.keys()]).toEqual([1, 2]);
  });
});

describe("liquidoUpfrontExibido", () => {
  const plano = planearMargensDoComercial({
    config: { ativo: true, tipoPeriodo: "MENSAL", vigenteDesde: null, criadoEm: data("2026-01-01") },
    escaloesAtivos: [{ operadoraId: 1, ...degrau(1, 0, 80) }],
    carimbos: [],
    linhas: [{ operadoraId: 1, dataInicioContrato: data("2026-01-10"), valorUpfrontBruto: d("600.01") }],
    hoje: data("2026-01-15"),
  });

  it("com patamar: bruto × margem / 100, a 2 casas (600.01 × 80% = 480.008 → 480.01)", () => {
    const l = { operadoraId: 1, dataInicioContrato: data("2026-01-10"), valorUpfrontBruto: d("600.01"), valorUpfrontLiquido: d(300) };
    expect(liquidoUpfrontExibido(l, plano).toString()).toBe("480.01");
  });

  it("sem patamar, sem data ou sem plano: o líquido guardado", () => {
    const l = { operadoraId: 1, dataInicioContrato: null, valorUpfrontBruto: d(600), valorUpfrontLiquido: d(300) };
    expectValor(liquidoUpfrontExibido(l, plano), 300);
    expectValor(liquidoUpfrontExibido({ ...l, dataInicioContrato: data("2026-01-10") }, PlanoMargensComercial.INATIVO), 300);
    expectValor(liquidoUpfrontExibido({ ...l, valorUpfrontLiquido: null }, null), 0);
  });
});

describe("planearFechoDaEmpresa (PatamaresFechoService sem a BD)", () => {
  const base = {
    config: { ativo: true, tipoPeriodo: "MENSAL", vigenteDesde: data("2026-01-15"), criadoEm: data("2025-06-01") },
    escaloesAtivos: [
      { id: 10, aspnetUserId: "u1", operadoraId: 1, ...degrau(1, 0, 80) },
      { id: 11, aspnetUserId: "u1", operadoraId: 1, ...degrau(2, 1000, 90) },
    ],
    membros: [
      { idCrm: "100", aspnetUserId: "u1" },
      { idCrm: "", aspnetUserId: "u2" },
    ],
    carimbados: [],
    hoje: data("2026-03-10"),
  };
  const l = (idComercial: number | null, dataInicio: string, bruto: number, estado = "ATIVO") => ({
    idComercial,
    estadoNegocio: estado,
    operadoraId: 1,
    dataInicioContrato: data(dataInicio),
    valorUpfrontBruto: d(bruto),
  });

  it("carimba os períodos fechados desde vigente_desde, com o id do degrau", () => {
    const novos = planearFechoDaEmpresa({
      ...base,
      linhas: [
        l(100, "2025-12-10", 5000), // antes de vigente_desde (balde Jan) → fora
        l(100, "2026-01-10", 600),
        l(100, "2026-01-20", 600), // Jan: 1200 → degrau 2 (id 11)
        l(100, "2026-02-05", 300, "ANULADO"), // não conta
        l(100, "2026-02-06", 400, "EM_VALIDACAO"), // não conta
        l(100, "2026-02-07", 200), // Fev: 200 → degrau 1 (id 10)
        l(200, "2026-01-10", 999), // comercial sem membro → fora
        l(null, "2026-01-10", 999), // sem comercial → fora
        l(100, "2026-03-01", 5000), // Mar aberto → fora
      ],
    });
    expect(
      novos.map((c) => [c.aspnetUserId, c.periodo.inicio, c.percentagemComercial.toString(), c.idPatamar, c.brutoAcumulado.toString()]),
    ).toEqual([
      ["u1", "2026-01-01", "90", 11, "1200"],
      ["u1", "2026-02-01", "80", 10, "200"],
    ]);
  });

  it("sem config ativa ou sem escalões não carimba nada", () => {
    const linhas = [l(100, "2026-01-10", 600)];
    expect(planearFechoDaEmpresa({ ...base, linhas, config: { ...base.config, ativo: false } })).toEqual([]);
    expect(planearFechoDaEmpresa({ ...base, linhas, escaloesAtivos: [] })).toEqual([]);
  });

  it("id_crm duplicado depois do parse lança, como o ToDictionary do C#", () => {
    expect(() =>
      planearFechoDaEmpresa({
        ...base,
        linhas: [],
        membros: [
          { idCrm: "100", aspnetUserId: "u1" },
          { idCrm: " 100", aspnetUserId: "u3" },
        ],
      }),
    ).toThrow(/duplicada/);
  });
});
