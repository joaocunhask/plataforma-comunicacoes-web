// A forma canónica tem de dar o mesmo texto para o valor lido do SQL Server (já convertido
// pelo SELECT do ETL) e para o mesmo valor lido do Postgres com ::text.
import { describe, expect, it } from "vitest";
import { canonico, expressaoOrigem } from "../../scripts/etl/canonico";

const igual = (tipo: string, origem: unknown, destino: unknown) =>
  expect(canonico(origem, tipo)).toBe(canonico(destino, tipo));

describe("canonico", () => {
  it("datas/horas: o Postgres corta os zeros finais, o estilo 121 do SQL Server não", () => {
    igual("timestamp without time zone", "2026-09-18 09:40:00.120", "2026-09-18 09:40:00.12");
    igual("timestamp without time zone", "2026-09-18 09:40:00.000000", "2026-09-18 09:40:00");
    igual("timestamp without time zone", "2026-09-18 09:40:00.123457", "2026-09-18 09:40:00.123457");
    expect(canonico("2026-09-18 09:40:00.12", "timestamp without time zone")).not.toBe(
      canonico("2026-09-18 09:40:00.121", "timestamp without time zone"),
    );
  });

  it("instantes com fuso: os dois lados em UTC", () => {
    igual("timestamp with time zone", "2026-07-15 10:00:00.500000+00", "2026-07-15 10:00:00.5+00");
    expect(() => canonico("2026-07-15 10:00:00+01", "timestamp with time zone")).toThrow(/UTC/);
  });

  it("booleanos, bytea, uuid e numéricos", () => {
    igual("boolean", true, "true");
    igual("boolean", false, "false");
    igual("bytea", Buffer.from([0xde, 0xad, 0x01]), "\\xdead01");
    igual("uuid", "6f1c2a4e-1d2b-4c3d-9e8f-0a1b2c3d4e5f", "6F1C2A4E-1D2B-4C3D-9E8F-0A1B2C3D4E5F");
    igual("numeric", "600.00", "600.00");
    expect(canonico("600.00", "numeric")).not.toBe(canonico("600", "numeric")); // a escala conta
    igual("integer", 42, "42");
    expect(canonico(null, "text")).toBeNull();
  });
});

describe("expressaoOrigem", () => {
  it("converte no SQL Server o que o driver estragaria", () => {
    expect(expressaoOrigem("valor", "decimal")).toBe("CONVERT(varchar(60), [valor])");
    expect(expressaoOrigem("em", "datetime2")).toContain("datetime2(6)");
    expect(expressaoOrigem("nome", "nvarchar")).toBe("[nome]");
    expect(() => expressaoOrigem("x", "xml")).toThrow();
  });
});
