// Operações de texto com as regras do .NET que o motor de cálculo usa para decidir
// (Trim, IsNullOrWhiteSpace, int.TryParse). As do JavaScript diferem nos detalhes:
// o trim() do JS corta U+FEFF e não corta U+0085, e Number()/parseInt aceitam
// formatos que o int.TryParse recusa (e vice-versa). Ver tests/oraculo.

/** char.IsWhiteSpace do .NET: categorias Zs/Zl/Zp mais \t \n \v \f \r e U+0085. */
const ESPACO_NET = "[\\p{Zs}\\p{Zl}\\p{Zp}\\t\\n\\v\\f\\r\\u0085]";
const BORDAS_COM_ESPACO = new RegExp(`^${ESPACO_NET}+|${ESPACO_NET}+$`, "gu");
const SO_ESPACOS = new RegExp(`^${ESPACO_NET}*$`, "u");

/** string.Trim() do .NET. */
export function trimNet(texto: string): string {
  return texto.replace(BORDAS_COM_ESPACO, "");
}

const I_SEM_PONTO = String.fromCharCode(0x0131);

/**
 * char.ToUpperInvariant do .NET: um carácter dá sempre um carácter. O toUpperCase() do JS
 * expande alguns ("ß" → "SS", "ﬆ" → "ST"), que o .NET deixa como estão, e passa o i sem
 * ponto a "I", que o .NET também deixa (exceção deliberada do runtime, com ICU ou sem ele).
 */
export function maiusculaInvariantNet(c: string): string {
  if (c === I_SEM_PONTO) return c;
  const maiuscula = c.toUpperCase();
  return maiuscula.length === 1 ? maiuscula : c;
}

/** string.ToUpperInvariant() do .NET (carácter a carácter, ver maiusculaInvariantNet). */
export function toUpperInvariantNet(texto: string): string {
  let resultado = "";
  for (let i = 0; i < texto.length; i++) resultado += maiusculaInvariantNet(texto[i]);
  return resultado;
}

/** string.IsNullOrWhiteSpace do .NET. */
export function vazioOuEspacosNet(texto: string | null | undefined): boolean {
  return texto == null || SO_ESPACOS.test(texto);
}

/** string.IsNullOrEmpty do .NET. */
export function vazioNet(texto: string | null | undefined): texto is null | undefined | "" {
  return texto == null || texto.length === 0;
}

// int.TryParse(s) com NumberStyles.Integer: espaços ASCII (\t\n\v\f\r e espaço) à volta,
// sinal opcional, só dígitos 0-9, e o .NET tolera ainda '\0' no fim.
const INTEIRO_NET = /^[\t\n\v\f\r ]*([+-]?)(\d+)[\t\n\v\f\r ]*\0*$/;
const INT32_MIN = -(2n ** 31n);
const INT32_MAX = 2n ** 31n - 1n;

/** int.TryParse do .NET: o inteiro de 32 bits, ou null se o .NET devolvesse false. */
export function tryParseIntNet(texto: string | null | undefined): number | null {
  if (texto == null) return null;
  const m = INTEIRO_NET.exec(texto);
  if (!m) return null;
  const valor = BigInt(m[2]) * (m[1] === "-" ? -1n : 1n);
  return valor < INT32_MIN || valor > INT32_MAX ? null : Number(valor);
}
