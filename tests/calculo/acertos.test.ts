// O comercial dos acertos (AcertosService): rácio do negócio e agregado do painel.
import { describe, expect, it } from "vitest";
import {
  type AcertoParaAgregar,
  agregarAcertosPorNegocio,
  comercialDerivado,
  type LinhaParaRacio,
  planearMargensDoComercial,
  raciosComercial,
  TiposAcerto,
} from "@/lib/calculo";
import { d, data, expectValor } from "./ajuda";

const linha = (alteracoes: Partial<LinhaParaRacio>): LinhaParaRacio => ({
  idSysNegocio: "n1",
  operadoraId: 1,
  dataInicioContrato: data("2026-01-10"),
  valorUpfrontBruto: d("600.00"),
  valorUpfrontLiquido: d("300.00"),
  premiosBruto: null,
  premiosLiquido: null,
  idComercial: 100,
  ...alteracoes,
});

describe("raciosComercial", () => {
  it("sem patamar usa o líquido guardado; prémio pelo guardado; bruto zero dá rácio zero", () => {
    const r = raciosComercial(
      [linha({ premiosBruto: d("20.00"), premiosLiquido: d("5.00") }), linha({ idSysNegocio: "n2", valorUpfrontBruto: d(0) })],
      new Map(),
    );
    expectValor(r.get("n1")!.up, "0.5");
    expectValor(r.get("n1")!.prem, "0.25");
    expectValor(r.get("n2")!.up, 0);
    expectValor(r.get("n2")!.prem, 0);
  });

  it("com patamar, o upfront usa bruto × margem do comercial (do comercial da 1.ª linha)", () => {
    const plano = planearMargensDoComercial({
      config: { ativo: true, tipoPeriodo: "MENSAL", vigenteDesde: null, criadoEm: data("2026-01-01") },
      escaloesAtivos: [{ operadoraId: 1, ordem: 1, limiteInferior: d(0), percentagemComercial: d(80) }],
      carimbos: [],
      linhas: [{ operadoraId: 1, dataInicioContrato: data("2026-01-10"), valorUpfrontBruto: d(600) }],
      hoje: data("2026-01-20"),
    });
    const r = raciosComercial([linha({})], new Map([["100", plano]]));
    expectValor(r.get("n1")!.up, "0.8"); // 480 / 600, não 300 / 600
  });
});

describe("comercialDerivado", () => {
  it("delta upfront × rácio up + delta prémio × rácio prémio, a 2 casas", () => {
    const racio = { up: d("0.5"), prem: d("0.25") };
    expectValor(comercialDerivado({ deltaUpfrontBruto: d("-100.01"), deltaPremioBruto: d("10.00") }, racio), "-47.51");
    expectValor(comercialDerivado({ deltaUpfrontBruto: null, deltaPremioBruto: null }, racio), 0);
  });
});

describe("agregarAcertosPorNegocio", () => {
  const acerto = (alteracoes: Partial<AcertoParaAgregar>): AcertoParaAgregar => ({
    idSysNegocio: "n1",
    idTipoAcerto: TiposAcerto.AjusteManual,
    deltaBruto: d("100.00"),
    deltaLiquido: null,
    deltaUpfrontBruto: d("100.00"),
    deltaPremioBruto: null,
    criadoEmMicros: 1_000n,
    ...alteracoes,
  });

  it("soma o bruto e o comercial efetivo (override ou derivado); só os override ficam desatualizados", () => {
    const r = agregarAcertosPorNegocio(
      [
        acerto({}), // derivado: 100 × 0.5 = 50
        acerto({ deltaLiquido: d("70.00"), criadoEmMicros: 500n }), // override antes do recálculo → desatualizado
        acerto({ deltaLiquido: d("0"), deltaBruto: d("0"), criadoEmMicros: 600n }), // override a zero → não conta
        acerto({ idTipoAcerto: TiposAcerto.Recalculo, deltaBruto: d("0"), deltaUpfrontBruto: null, criadoEmMicros: 900n }),
        acerto({ deltaLiquido: d("10.00"), criadoEmMicros: 2_000n }), // override depois → em dia
      ],
      new Map([["n1", { up: d("0.5"), prem: d(0) }]]),
    );
    const n1 = r.get("n1")!;
    expect(n1.n).toBe(5);
    expectValor(n1.bruto, "300.00");
    expectValor(n1.liquido, "130.00"); // 50 + 70 + 0 + 0 + 10
    expect(n1.desatualizados).toBe(1);
  });

  it("sem rácio conhecido, o derivado vale 0", () => {
    const r = agregarAcertosPorNegocio([acerto({ idSysNegocio: "n9" })], new Map());
    expectValor(r.get("n9")!.liquido, 0);
  });
});
