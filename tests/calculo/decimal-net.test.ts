// O tipo decimal: a API e as particularidades do .NET que ele reproduz. A fidelidade
// caso a caso está em tests/oraculo (milhares de contas feitas pelo próprio .NET).
import { describe, expect, it } from "vitest";
import { NetDecimal } from "@/lib/calculo";
import { d } from "./ajuda";

describe("NetDecimal", () => {
  it("lê texto e mantém a escala, como o decimal do .NET", () => {
    expect(d("600.00").toString()).toBe("600.00");
    expect(d("-0.5").toString()).toBe("-0.5");
    expect(d(" 12 ").toString()).toBe("12");
    expect(d(42).toString()).toBe("42");
    expect(d("600.00").eq(d(600))).toBe(true);
  });

  it("recusa floats e texto inválido (um float já perdeu os cêntimos)", () => {
    expect(() => d(0.1)).toThrow(TypeError);
    expect(() => d("1e3")).toThrow(TypeError);
    expect(() => d("12,5")).toThrow(TypeError);
    expect(() => d("")).toThrow(TypeError);
  });

  it("arredonda meio para longe do zero por omissão, e ao par quando pedido", () => {
    expect(d("23.52195").round(2).toString()).toBe("23.52");
    expect(d("0.125").round(2).toString()).toBe("0.13");
    expect(d("-0.125").round(2).toString()).toBe("-0.13");
    expect(d("0.125").round(2, "ao-par").toString()).toBe("0.12");
    expect(d("600").round(2).toString()).toBe("600"); // não acrescenta casas
  });

  it("divide como o .NET: exato fica com a escala e1−e2, inexato perde os zeros finais", () => {
    expect(d("600.00").div(100).toString()).toBe("6.00");
    expect(d(1).div(3).toString()).toBe("0.3333333333333333333333333333");
    expect(d(100).div(3).toString()).toBe("33.333333333333333333333333333");
    expect(d(1).div(8).toString()).toBe("0.125");
  });

  it("arredonda ao par quando o resultado não cabe em 28 casas", () => {
    // 1/2^29 tem 29 casas e acaba em 5: empate exato na 29.ª casa.
    expect(d(1).div(2 ** 29).toString()).toBe("0.0000000018626451492309570312");
    expect(d(3).div(2 ** 29).toString()).toBe("0.0000000055879354476928710938");
  });

  it("um produto nulo segue a escala do .NET", () => {
    expect(d("0.00").times(d("1.5")).toString()).toBe("0.000");
    expect(d(0).times(d("3.0809366464977919762326388757")).toString()).toBe("0");
  });

  it("lança em divisão por zero e em overflow, como o .NET", () => {
    expect(() => d(1).div(0)).toThrow(RangeError);
    expect(() => d("79228162514264337593543950335").times(2)).toThrow(RangeError);
  });

  it("compara e soma pelo valor", () => {
    expect(d("1.10").cmp(d("1.1"))).toBe(0);
    expect(d("-1").lt(0)).toBe(true);
    expect(NetDecimal.soma([d("0.10"), d("0.20"), d("0.3")]).toString()).toBe("0.60");
    expect(NetDecimal.min(d("2"), d("1.5")).toString()).toBe("1.5");
    expect(JSON.stringify({ v: d("1.50") })).toBe('{"v":"1.50"}');
  });
});
