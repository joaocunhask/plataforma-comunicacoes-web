// Leitura dos webhooks do Pipedrive e do JSON exato (port de PipedriveNativeWebhookMapper e
// WebhooksEndpoints, e dos testes C# correspondentes).
import { describe, expect, it } from "vitest";
import { decimal, inteiro, parseJsonExato, texto } from "@/lib/pipedrive/json-exato";
import {
  ehTransicaoParaGanho,
  entradaDoNativo,
  lerDataInicio,
  lerGuid,
  lerPayloadUpfront,
  tokenDoBasicAuth,
} from "@/lib/pipedrive/webhooks";

const TOKEN = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("json exato", () => {
  it("preços sem passar por float, com a escala do texto", () => {
    const o = parseJsonExato('{"item_price":49.90,"id":7,"x":0.1}') as Record<string, unknown>;
    expect(decimal(o.item_price)?.toString()).toBe("49.90");
    expect(decimal(o.x)?.toString()).toBe("0.1");
    expect(inteiro(o.id)).toBe(7);
    expect(inteiro(o.item_price)).toBeNull();
    expect(texto(o.id)).toBe("7");
  });
});

describe("autenticação", () => {
  it("Guid.TryParse: com ou sem hífens, entre chavetas; o resto não", () => {
    expect(lerGuid(TOKEN.toUpperCase())).toBe(TOKEN);
    expect(lerGuid(TOKEN.replace(/-/g, ""))).toBe(TOKEN);
    expect(lerGuid(`{${TOKEN}}`)).toBe(TOKEN);
    expect(lerGuid(` ${TOKEN} `)).toBe(TOKEN);
    expect(lerGuid("nao-e-guid")).toBeNull();
    expect(lerGuid(`${TOKEN}0`)).toBeNull();
  });

  it("Basic Auth: a password é o token; o utilizador ignora-se", () => {
    expect(tokenDoBasicAuth(basic("qualquer", TOKEN))).toBe(TOKEN);
    expect(tokenDoBasicAuth(basic("", TOKEN))).toBe(TOKEN);
    expect(tokenDoBasicAuth(`basic ${Buffer.from(`x:${TOKEN}`).toString("base64")}`)).toBe(TOKEN);
    expect(tokenDoBasicAuth(null)).toBeNull();
    expect(tokenDoBasicAuth(`Bearer ${TOKEN}`)).toBeNull();
    expect(tokenDoBasicAuth("Basic !!!")).toBeNull();
    expect(tokenDoBasicAuth(`Basic ${Buffer.from(TOKEN).toString("base64")}`)).toBeNull(); // sem ':'
    expect(tokenDoBasicAuth(basic("x", "errado"))).toBeNull();
  });
});

describe("data de início", () => {
  it.each([
    ["2026-07-31", "2026-07-31"],
    ["2026-07-31 15:35:36", "2026-07-31"],
    ["2026-07-31T23:59:59Z", "2026-07-31"],
    ["2026-07-31T00:30:00+01:00", "2026-07-30"], // com fuso: passa a UTC
    ["", null],
    ["   ", null],
    ["31/07/2026", null],
    ["2026-02-30", null],
  ])("%j → %j", (entrada, esperado) => {
    expect(lerDataInicio(entrada)).toBe(esperado);
  });
});

describe("/upfront", () => {
  const base = { webhook_token: TOKEN, id_funil: "3", id_negocio: "1201", id_comercial: "15", titulo_negocio: "Cliente X" };

  it("lê o payload da automação", () => {
    const r = lerPayloadUpfront({ ...base, inicio_contrato: "2026-07-31 15:35:36", oportunidade: "OP-9" });
    expect(r).toEqual({
      ok: true,
      webhookToken: TOKEN,
      entrada: {
        idFunil: 3,
        nomeFunil: null,
        idNegocio: 1201,
        tituloNegocio: "Cliente X",
        idComercial: 15,
        contactoServico: null,
        inicioContrato: "2026-07-31",
        idSimulador: null,
        oportunidade: "OP-9",
      },
    });
  });

  it("o token verifica-se antes de tudo (401), os ids depois (400)", () => {
    expect(lerPayloadUpfront({ ...base, webhook_token: "x", id_funil: "abc" })).toMatchObject({ ok: false, status: 401 });
    expect(lerPayloadUpfront({ ...base, id_funil: "abc" })).toMatchObject({ ok: false, status: 400, mensagem: "id_funil inválido." });
    expect(lerPayloadUpfront({ ...base, id_negocio: undefined })).toMatchObject({ status: 400, mensagem: "id_negocio inválido." });
    expect(lerPayloadUpfront({ ...base, id_comercial: " 15 " })).toMatchObject({ ok: true });
  });
});

describe("/native", () => {
  const ganho = { id: 77, title: "Negócio", pipeline_id: 3, status: "won", owner_id: 15, won_time: "2026-07-31T15:35:36Z" };

  it("só a transição para ganho conta", () => {
    expect(ehTransicaoParaGanho({ data: ganho, previous: { status: "open" } })).toBe(true);
    expect(ehTransicaoParaGanho({ current: ganho })).toBe(true); // criado já ganho (v1)
    expect(ehTransicaoParaGanho({ data: ganho, previous: { status: "won" } })).toBe(false);
    expect(ehTransicaoParaGanho({ data: { ...ganho, status: "lost" } })).toBe(false);
    expect(ehTransicaoParaGanho({ data: { ...ganho, status: "WON" } })).toBe(true);
    expect(ehTransicaoParaGanho({})).toBe(false);
  });

  it("o dono: owner_id (v2) primeiro, depois user_id (v1), em número, texto ou objeto", () => {
    expect(entradaDoNativo({ data: ganho })?.idComercial).toBe(15);
    expect(entradaDoNativo({ current: { ...ganho, owner_id: undefined, user_id: { id: 21 } } })?.idComercial).toBe(21);
    expect(entradaDoNativo({ current: { ...ganho, owner_id: undefined, user_id: { value: 22 } } })?.idComercial).toBe(22);
    expect(entradaDoNativo({ current: { ...ganho, owner_id: "23" } })?.idComercial).toBe(23);
    expect(entradaDoNativo({ data: { ...ganho, owner_id: null, user_id: null } })).toBeNull();
    expect(entradaDoNativo({ data: { ...ganho, pipeline_id: undefined } })).toBeNull();
  });

  it("monta a entrada; oportunidade e id_simulador ficam para o apuramento", () => {
    expect(entradaDoNativo({ data: ganho })).toEqual({
      idFunil: 3,
      nomeFunil: null,
      idNegocio: 77,
      tituloNegocio: "Negócio",
      idComercial: 15,
      contactoServico: null,
      inicioContrato: "2026-07-31",
      idSimulador: null,
      oportunidade: null,
    });
  });
});
