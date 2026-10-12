// Datas civis (o DateOnly do .NET) como texto "AAAA-MM-DD", sem horas nem fuso.
// Evita o Date do JavaScript de propósito: um Date é um instante, e converter uma data
// de início de contrato para instante e de volta é a forma clássica de a mudar de dia.
// No formato AAAA-MM-DD a comparação de texto (<, >) é a comparação de datas.

declare const marca: unique symbol;
export type DataCivil = string & { readonly [marca]: "DataCivil" };

const FORMATO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function diasNoMes(ano: number, mes: number): number {
  if (mes === 2) return (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0 ? 29 : 28;
  return mes === 4 || mes === 6 || mes === 9 || mes === 11 ? 30 : 31;
}

/** Valida e marca um texto "AAAA-MM-DD" como data civil. */
export function dataCivil(texto: string): DataCivil {
  const m = FORMATO.exec(texto);
  if (m) {
    const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (ano >= 1 && mes >= 1 && mes <= 12 && dia >= 1 && dia <= diasNoMes(ano, mes)) return texto as DataCivil;
  }
  throw new TypeError(`Data inválida "${texto}" (esperado AAAA-MM-DD).`);
}

export function montarData(ano: number, mes: number, dia: number): DataCivil {
  return dataCivil(`${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`);
}

export function partesDaData(data: DataCivil): { ano: number; mes: number; dia: number } {
  return { ano: Number(data.slice(0, 4)), mes: Number(data.slice(5, 7)), dia: Number(data.slice(8, 10)) };
}

/** Trimestre civil (1–4) de uma data. */
export function trimestreDe(data: DataCivil): number {
  return Math.floor((partesDaData(data).mes - 1) / 3) + 1;
}

/** DateOnly.FromDateTime(DateTime.UtcNow): o dia de hoje em UTC. */
export function hojeUtc(agora: Date = new Date()): DataCivil {
  return dataCivil(agora.toISOString().slice(0, 10));
}
