// A compatibilidade com o Identity contra o próprio Identity: cada caso de identity-net.json
// foi calculado pelo pacote Microsoft.Extensions.Identity.Core de produção
// (ferramentas/oraculo-net/Identity.cs).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Base64InvalidoError,
  calcularTotp,
  ChaveBase32InvalidaError,
  deBase32Identity,
  paraBase32Identity,
  PasswordUtf16InvalidaError,
  type ResultadoPassword,
  validarCodigoAutenticador,
  verificarPasswordIdentity,
} from "@/lib/identity";

/* eslint-disable @typescript-eslint/no-explicit-any -- casos lidos de JSON */
type Caso = any;

const oraculo: { seccoes: Record<string, Caso[]> } = JSON.parse(
  readFileSync(join(__dirname, "identity-net.json"), "utf8"),
);

const NOMES_NET: Record<ResultadoPassword, string> = {
  falhou: "Failed",
  ok: "Success",
  "ok-rehash": "SuccessRehashNeeded",
};

function nomeDoErro(e: unknown): string {
  if (e instanceof Base64InvalidoError) return "erro:FormatException";
  if (e instanceof ChaveBase32InvalidaError) return "erro:FormatException";
  if (e instanceof PasswordUtf16InvalidaError) return "erro:EncoderFallbackException";
  throw e;
}

describe("oráculo Identity", () => {
  it(
    "password: VerifyHashedPassword dá o mesmo resultado em todos os casos",
    async () => {
      const divergencias: unknown[] = [];
      for (const caso of oraculo.seccoes.password) {
        for (const { tentativa: texto, utf16, resultado } of caso.resultados) {
          const tentativa: string = utf16 ? String.fromCharCode(...utf16) : texto;
          let obtido: string;
          try {
            obtido = NOMES_NET[await verificarPasswordIdentity(caso.hash, tentativa)];
          } catch (e) {
            obtido = nomeDoErro(e);
          }
          if (obtido !== resultado) divergencias.push({ tipo: caso.tipo, hash: caso.hash, tentativa, resultado, obtido });
        }
      }
      expect(divergencias).toEqual([]);
    },
    60_000,
  );

  it("base32: ToBase32 igual em todos os tamanhos", () => {
    for (const c of oraculo.seccoes.base32Para) {
      expect(paraBase32Identity(Buffer.from(c.bytesHex, "hex"))).toBe(c.texto);
    }
  });

  it("base32: FromBase32 igual (incluindo minúsculas, '=' e caracteres inválidos)", () => {
    for (const c of oraculo.seccoes.base32De) {
      let obtido: unknown;
      try {
        obtido = { bytesHex: deBase32Identity(c.texto).toString("hex").toUpperCase() };
      } catch (e) {
        obtido = { erro: nomeDoErro(e).slice("erro:".length) };
      }
      expect({ texto: c.texto, ...(obtido as object) }).toEqual(c);
    }
  });

  it("totp: ComputeTotp dá o mesmo código (chaves de vários tamanhos, passos extremos)", () => {
    for (const c of oraculo.seccoes.totp) {
      expect(calcularTotp(Buffer.from(c.chaveHex, "hex"), BigInt(c.passo))).toBe(c.codigo);
    }
  });

  it("autenticador: ValidateAsync aceita e recusa os mesmos códigos (janela ±2, formatos do código)", () => {
    const divergencias: unknown[] = [];
    for (const c of oraculo.seccoes.autenticador) {
      for (const { token, resultado } of c.resultados) {
        let obtido: string;
        try {
          obtido = String(validarCodigoAutenticador(c.chave, token, c.agora));
        } catch (e) {
          obtido = nomeDoErro(e);
        }
        if (obtido !== resultado) divergencias.push({ chave: c.chave, agora: c.agora, token, resultado, obtido });
      }
    }
    expect(divergencias).toEqual([]);
  });
});
