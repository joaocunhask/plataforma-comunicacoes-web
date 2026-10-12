// Port de tests/.../Pipedrive/DealProductCommentsParserTests.cs (a parte Parse).
import { describe, expect, it } from "vitest";
import { lerSubscricoes, ObservacoesInvalidasError } from "@/lib/calculo";

const AVISO = "⚠ Gerado pela app Preencher Produtos — não remover.\n";

describe("lerSubscricoes", () => {
  it("extrai as subscrições ignorando a linha de aviso", () => {
    const subs = lerSubscricoes(
      AVISO + '{"subscricoes":[{"numero":"911111111","duracao_meses":30},{"numero":"922222222","duracao_meses":24}]}',
    );
    expect(subs).toEqual([
      { numero: "911111111", duracaoMeses: 30, quantidade: 1 },
      { numero: "922222222", duracaoMeses: 24, quantidade: 1 },
    ]);
  });

  it("aceita JSON sem linha de aviso", () => {
    expect(lerSubscricoes('{"subscricoes":[{"numero":"911111111","duracao_meses":30}]}')).toHaveLength(1);
  });

  it.each([null, "", "texto sem json", "{ json invalido", '{"outra_coisa":1}'])("entrada inválida (%j) → vazio", (texto) => {
    expect(lerSubscricoes(texto)).toEqual([]);
  });

  it("quantidade ausente vale 1; explícita é lida", () => {
    const subs = lerSubscricoes('{"subscricoes":[{"numero":"911","duracao_meses":24},{"duracao_meses":30,"quantidade":20}]}');
    expect(subs).toEqual([
      { numero: "911", duracaoMeses: 24, quantidade: 1 },
      { numero: null, duracaoMeses: 30, quantidade: 20 },
    ]);
  });

  it("mantém subscrições sem número (o número é opcional)", () => {
    const subs = lerSubscricoes('{"subscricoes":[{"duracao_meses":30},{"numero":"911111111","duracao_meses":24}]}');
    expect(subs[0]).toEqual({ numero: null, duracaoMeses: 30, quantidade: 1 });
    expect(subs[1].numero).toBe("911111111");
  });

  it("número com espaços é aparado; só espaços conta como sem número; quantidade < 1 vale 1", () => {
    expect(lerSubscricoes('{"subscricoes":[{"numero":"  912  ","duracao_meses":24,"quantidade":0}]}')).toEqual([
      { numero: "912", duracaoMeses: 24, quantidade: 1 },
    ]);
    expect(lerSubscricoes('{"subscricoes":[{"numero":"   ","duracao_meses":24}]}')[0].numero).toBeNull();
  });

  it("duração que não é um inteiro de 32 bits lança (o FormatException do C#)", () => {
    expect(() => lerSubscricoes('{"subscricoes":[{"duracao_meses":30.0}]}')).toThrow(ObservacoesInvalidasError);
    expect(() => lerSubscricoes('{"subscricoes":[{"duracao_meses":2147483648}]}')).toThrow(ObservacoesInvalidasError);
  });
});
