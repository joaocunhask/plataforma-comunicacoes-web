// Leitura do SQL Server e forma canónica dos valores, para os checksums do ETL.
//
// O driver mssql devolve decimal como number (float) e datetime como Date (com fuso): ambos
// estragam valores. Por isso o SELECT de origem converte esses tipos para texto no próprio
// SQL Server, e é esse texto que se insere no Postgres e entra no checksum.

/** Expressão do SELECT de origem para uma coluna, conforme o tipo no SQL Server. */
export function expressaoOrigem(coluna: string, tipo: string): string {
  const c = `[${coluna.replace(/]/g, "]]")}]`;
  switch (tipo) {
    case "decimal":
    case "numeric":
    case "money":
    case "smallmoney":
      return `CONVERT(varchar(60), ${c})`;
    case "bigint":
      return `CONVERT(varchar(20), ${c})`;
    case "uniqueidentifier":
      return `LOWER(CONVERT(char(36), ${c}))`;
    case "date":
      return `CONVERT(varchar(10), ${c}, 23)`;
    case "datetime":
    case "smalldatetime":
      return `CONVERT(varchar(30), ${c}, 121)`;
    case "datetime2":
      // O Postgres guarda microssegundos: o 7.º dígito arredonda-se já aqui, no SQL Server.
      return `CONVERT(varchar(30), CONVERT(datetime2(6), ${c}), 121)`;
    case "datetimeoffset":
      // Passa a UTC; no Postgres é timestamptz e a sessão do ETL corre em UTC.
      return `CONVERT(varchar(30), CONVERT(datetime2(6), SWITCHOFFSET(${c}, '+00:00')), 121) + '+00'`;
    case "time":
    case "xml":
    case "sql_variant":
    case "image":
    case "timestamp":
    case "rowversion":
      throw new Error(`Tipo ${tipo} (coluna ${coluna}) sem conversão definida no ETL`);
    default:
      return c; // int, bit, (n)varchar, (n)char, varbinary: o driver devolve-os sem perda
  }
}

const RE_INSTANTE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/;

function instante(texto: string): string {
  const m = RE_INSTANTE.exec(texto);
  if (!m) throw new Error(`Data/hora inesperada: ${texto}`);
  return `${m[1]} ${m[2]}.${(m[3] ?? "").padEnd(6, "0")}`;
}

/**
 * Forma canónica de um valor, igual venha ele do SQL Server (já convertido por
 * expressaoOrigem) ou do Postgres (lido com ::text). `tipo` é o data_type do Postgres.
 */
export function canonico(valor: unknown, tipo: string): string | null {
  if (valor === null || valor === undefined) return null;
  switch (tipo) {
    case "boolean":
      return valor === true || valor === 1 || valor === "true" || valor === "t" ? "1" : "0";
    case "bytea":
      return Buffer.isBuffer(valor) ? `\\x${valor.toString("hex")}` : String(valor);
    case "uuid":
      return String(valor).toLowerCase();
    case "timestamp without time zone":
      return instante(String(valor));
    case "timestamp with time zone": {
      const s = String(valor);
      const m = /^(.*?)(?:Z|\+00(?::00)?)$/.exec(s);
      if (!m) throw new Error(`Instante fora de UTC: ${s}`);
      return `${instante(m[1])}Z`;
    }
    default:
      return String(valor);
  }
}
