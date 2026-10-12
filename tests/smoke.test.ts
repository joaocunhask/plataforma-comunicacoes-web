import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

describe("decimal.js", () => {
  it("soma dinheiro sem erros de vírgula flutuante", () => {
    expect(new Decimal("0.1").plus("0.2").toFixed(2)).toBe("0.30");
  });
});
