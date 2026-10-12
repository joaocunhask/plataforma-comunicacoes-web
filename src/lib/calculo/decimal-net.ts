// Decimal com a semântica EXATA do System.Decimal do .NET, para o motor de cálculo dar
// os mesmos cêntimos que o C# (UpfrontCalculator, TrimestralPremiosCalculator, …).
//
// Porquê um tipo próprio e não decimal.js: o decimal do .NET não é "precisão arbitrária".
// É uma mantissa inteira de 96 bits com escala 0..28, e quando um resultado não cabe
// (divisões como liquido/bruto, produtos com mais de 28 casas) arredonda AO PAR, uma
// única vez, para o valor representável mais próximo. Só reproduzindo essas regras é que
// uma conta como Math.Round(delta × (liq / bruto), 2) dá sempre o mesmo cêntimo.
//
// As regras estão validadas contra o próprio .NET em tests/oraculo (casos gerados pela
// ferramenta em ferramentas/oraculo-net).

const MANTISSA_MAX = (1n << 96n) - 1n;
const MANTISSA_32_MAX = (1n << 32n) - 1n;
const ESCALA_MAX = 28;

const POTENCIAS_10: readonly bigint[] = Array.from({ length: 64 }, (_, i) => 10n ** BigInt(i));
const pot10 = (n: number): bigint => POTENCIAS_10[n] ?? 10n ** BigInt(n);

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/** Quociente n/d arredondado ao par (como o .NET faz quando um resultado não cabe). */
function dividirAoPar(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const dobroResto = abs(r) * 2n;
  const absD = abs(d);
  if (dobroResto > absD || (dobroResto === absD && (q & 1n) !== 0n)) {
    return (n < 0n) !== (d < 0n) ? q - 1n : q + 1n;
  }
  return q;
}

/** Quociente n/d arredondado "meio para longe do zero" (MidpointRounding.AwayFromZero). */
function dividirLongeDoZero(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  if (abs(r) * 2n >= abs(d)) return (n < 0n) !== (d < 0n) ? q - 1n : q + 1n;
  return q;
}

/** Modo de arredondamento de {@link NetDecimal.round}, como o MidpointRounding do .NET. */
export type ModoArredondamento = "longe-do-zero" | "ao-par";

const FORMATO_DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;

export class NetDecimal {
  static readonly ZERO = new NetDecimal(0n, 0);
  static readonly UM = new NetDecimal(1n, 0);
  static readonly CEM = new NetDecimal(100n, 0);

  private constructor(
    /** Inteiro com sinal; o valor é mantissa / 10^escala. */
    readonly mantissa: bigint,
    readonly escala: number,
  ) {}

  /**
   * Cria um decimal. Aceita texto ("600.00", "-0.5"), inteiros seguros e bigint.
   * Números não inteiros são recusados de propósito: um float já perdeu os cêntimos.
   */
  static de(valor: NetDecimal | string | number | bigint): NetDecimal {
    if (valor instanceof NetDecimal) return valor;
    if (typeof valor === "bigint") return NetDecimal.ajustar(valor, 0);
    if (typeof valor === "number") {
      if (!Number.isSafeInteger(valor)) {
        throw new TypeError(`NetDecimal.de: só aceita inteiros seguros como number (recebeu ${valor}); use texto.`);
      }
      return NetDecimal.ajustar(BigInt(valor), 0);
    }
    const m = FORMATO_DECIMAL.exec(valor.trim());
    if (!m) throw new TypeError(`NetDecimal.de: texto inválido "${valor}".`);
    const [, sinal, inteira, fracao = ""] = m;
    const mantissa = BigInt(inteira + fracao);
    return NetDecimal.ajustar(sinal === "-" ? -mantissa : mantissa, fracao.length);
  }

  /** Como {@link de}, mas deixa passar null/undefined. */
  static deOuNull(valor: NetDecimal | string | number | bigint | null | undefined): NetDecimal | null {
    return valor == null ? null : NetDecimal.de(valor);
  }

  /** Σ dos valores, somados pela ordem dada (a ordem só importa num overflow). */
  static soma(valores: Iterable<NetDecimal>): NetDecimal {
    let total = NetDecimal.ZERO;
    for (const v of valores) total = total.plus(v);
    return total;
  }

  /** Math.Min(a, b) do .NET. */
  static min(a: NetDecimal, b: NetDecimal): NetDecimal {
    return b.lt(a) ? b : a;
  }

  /**
   * Reduz (m, escala) ao decimal .NET representável: escala ≤ 28 e |mantissa| < 2^96,
   * com UM só arredondamento ao par a partir do valor exato.
   */
  private static ajustar(mantissa: bigint, escala: number): NetDecimal {
    for (let k = Math.max(0, escala - ESCALA_MAX); ; k++) {
      const q = k === 0 ? mantissa : dividirAoPar(mantissa, pot10(k));
      if (abs(q) <= MANTISSA_MAX) return new NetDecimal(q, escala - k);
      if (k >= escala) throw new RangeError("NetDecimal: valor fora do intervalo do decimal do .NET.");
    }
  }

  private alinhado(outro: NetDecimal): [bigint, bigint, number] {
    if (this.escala === outro.escala) return [this.mantissa, outro.mantissa, this.escala];
    const escala = Math.max(this.escala, outro.escala);
    return [
      this.mantissa * pot10(escala - this.escala),
      outro.mantissa * pot10(escala - outro.escala),
      escala,
    ];
  }

  plus(outro: NetDecimal | number): NetDecimal {
    const [a, b, escala] = this.alinhado(NetDecimal.de(outro));
    return NetDecimal.ajustar(a + b, escala);
  }

  minus(outro: NetDecimal | number): NetDecimal {
    const [a, b, escala] = this.alinhado(NetDecimal.de(outro));
    return NetDecimal.ajustar(a - b, escala);
  }

  /**
   * Multiplicação do .NET. O valor é o produto exato ajustado a 28 casas / 96 bits; a
   * ESCALA de um produto nulo segue o caminho de código do .NET (confirmado no oráculo):
   * com os dois operandos em 32 bits mantém a escala (até 28) e, acima de 28+19 casas,
   * dá zero sem casas; com um operando maior, um produto nulo dá sempre zero sem casas.
   */
  times(outro: NetDecimal | number): NetDecimal {
    const o = NetDecimal.de(outro);
    const produto = this.mantissa * o.mantissa;
    const escala = this.escala + o.escala;
    const ambosEm32Bits = abs(this.mantissa) <= MANTISSA_32_MAX && abs(o.mantissa) <= MANTISSA_32_MAX;
    if (ambosEm32Bits ? escala > ESCALA_MAX + 19 : produto === 0n) return NetDecimal.ZERO;
    return NetDecimal.ajustar(produto, escala);
  }

  /**
   * Divisão do .NET. Se o quociente é exato à escala e1−e2, fica com essa escala; senão
   * leva o maior número de casas que cabe (até 28), arredondado ao par, e sem os zeros
   * finais. Lança em divisão por zero, como o .NET.
   */
  div(outro: NetDecimal | number): NetDecimal {
    const o = NetDecimal.de(outro);
    if (o.mantissa === 0n) throw new RangeError("NetDecimal: divisão por zero.");

    // valor = (m1 / 10^e1) / (m2 / 10^e2); à escala s, a mantissa é m1·10^(e2+s−e1) / m2.
    const fracao = (s: number): [bigint, bigint] => {
      const exp = o.escala + s - this.escala;
      return exp >= 0 ? [this.mantissa * pot10(exp), o.mantissa] : [this.mantissa, o.mantissa * pot10(-exp)];
    };

    const escalaInicial = Math.max(0, this.escala - o.escala);
    const [numInicial, denInicial] = fracao(escalaInicial);
    if (numInicial % denInicial === 0n) {
      const q = numInicial / denInicial;
      if (abs(q) <= MANTISSA_MAX) return new NetDecimal(q, escalaInicial);
    }

    for (let s = ESCALA_MAX; s >= 0; s--) {
      const [num, den] = fracao(s);
      let q = dividirAoPar(num, den);
      if (abs(q) > MANTISSA_MAX) continue;
      let e = s;
      while (e > 0 && q % 10n === 0n) {
        q /= 10n;
        e--;
      }
      return new NetDecimal(q, e);
    }
    throw new RangeError("NetDecimal: valor fora do intervalo do decimal do .NET.");
  }

  /** Math.Round(valor, casas, modo). Por omissão AwayFromZero, o que o motor usa sempre. */
  round(casas: number, modo: ModoArredondamento = "longe-do-zero"): NetDecimal {
    if (this.escala <= casas) return this;
    const divisor = pot10(this.escala - casas);
    const q = modo === "ao-par" ? dividirAoPar(this.mantissa, divisor) : dividirLongeDoZero(this.mantissa, divisor);
    return new NetDecimal(q, casas);
  }

  neg(): NetDecimal {
    return new NetDecimal(-this.mantissa, this.escala);
  }

  cmp(outro: NetDecimal | number): -1 | 0 | 1 {
    const [a, b] = this.alinhado(NetDecimal.de(outro));
    return a < b ? -1 : a > b ? 1 : 0;
  }

  eq(outro: NetDecimal | number): boolean {
    return this.cmp(outro) === 0;
  }
  lt(outro: NetDecimal | number): boolean {
    return this.cmp(outro) < 0;
  }
  lte(outro: NetDecimal | number): boolean {
    return this.cmp(outro) <= 0;
  }
  gt(outro: NetDecimal | number): boolean {
    return this.cmp(outro) > 0;
  }
  gte(outro: NetDecimal | number): boolean {
    return this.cmp(outro) >= 0;
  }
  isZero(): boolean {
    return this.mantissa === 0n;
  }

  /** Como o ToString(CultureInfo.InvariantCulture) do .NET: mantém a escala ("600.00"). */
  toString(): string {
    const negativo = this.mantissa < 0n;
    let digitos = abs(this.mantissa).toString();
    if (this.escala > 0) {
      digitos = digitos.padStart(this.escala + 1, "0");
      digitos = `${digitos.slice(0, -this.escala)}.${digitos.slice(-this.escala)}`;
    }
    return negativo ? `-${digitos}` : digitos;
  }

  toJSON(): string {
    return this.toString();
  }
}
