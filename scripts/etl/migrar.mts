// ETL SQL Server → Postgres, 1:1, com checksum por tabela.
//
//   npm run etl -- --simular     faz tudo e no fim desfaz (ROLLBACK): só o relatório
//   npm run etl                  migra (COMMIT só se todas as tabelas baterem)
//   npm run etl -- --confirmar   obrigatório quando o destino não é localhost
//
// Origem: MSSQL_CONNECTION_STRING — uma CÓPIA da BD de produção; o ETL só faz SELECT.
// Destino: DATABASE_URL — Postgres com as migrações aplicadas (npm run db:migrate) e vazio.
//
// Tudo corre numa só transação no Postgres: copia as tabelas pela ordem das chaves
// estrangeiras, volta a ler o que gravou e compara com a origem (contagem + SHA-256 das
// linhas na forma canónica). Se alguma tabela não bater, nada fica gravado.
//
// Além da cópia 1:1:
//   - AspNetUsers.Email passa a minúsculas (o Better Auth procura assim);
//   - o PasswordHash de cada utilizador passa para auth_contas (provider "credential"), onde o
//     login o lê, e fica NULL no AspNetUsers depois de verificado;
//   - as sequências das colunas identity avançam para o maior id migrado.
import { createHash, randomUUID } from "node:crypto";
import sql from "mssql";
import pg from "pg";
import { canonico, expressaoOrigem } from "./canonico";

/** Tabelas da origem que não passam: o motivo fica no relatório. */
const IGNORADAS: Record<string, string> = {
  __EFMigrationsHistory: "histórico de migrações do EF Core",
  // Da branch feat/catalogo-vigencias do .NET, ainda não em produção.
  ref_campanhas_vodafone: "ainda não existe no sistema novo (feat/catalogo-vigencias)",
  ref_produto_classe_vigencia: "ainda não existe no sistema novo (feat/catalogo-vigencias)",
};

/** Tabelas do destino que não vêm da origem (têm de estar vazias e ficam como estão). */
const SO_DESTINO = new Set(["auth_sessoes", "auth_contas", "auth_verificacoes"]);

/** Transformações aplicadas ao valor da origem antes de gravar (e antes do checksum). */
const TRANSFORMACOES: Record<string, Record<string, (v: unknown) => unknown>> = {
  AspNetUsers: { Email: (v) => (typeof v === "string" ? v.toLowerCase() : v) },
};

const LOTE = 500;
const simular = process.argv.includes("--simular");
const confirmar = process.argv.includes("--confirmar");

const origemUrl = process.env.MSSQL_CONNECTION_STRING;
const destinoUrl = process.env.DATABASE_URL;
if (!origemUrl) throw new Error("Falta MSSQL_CONNECTION_STRING no .env.local");
if (!destinoUrl) throw new Error("Falta DATABASE_URL no .env.local");

const destinoHost = new URL(destinoUrl).hostname;
const destinoLocal = ["localhost", "127.0.0.1", "::1"].includes(destinoHost);
console.log(`origem:  ${/(?:server|data source)=([^;]+)/i.exec(origemUrl)?.[1] ?? "?"}`);
console.log(`destino: ${destinoHost}${simular ? "  (simulação: no fim faz ROLLBACK)" : ""}`);
if (!destinoLocal && !simular && !confirmar) {
  console.error("O destino não é local: corre primeiro com --simular e depois com --confirmar.");
  process.exit(1);
}

type Coluna = { nome: string; tipoOrigem: string; tipoDestino: string; inserir: boolean };
type Tabela = { nome: string; colunas: Coluna[]; identity: string[] };

const origem = await sql.connect(origemUrl);
const destino = new pg.Client({ connectionString: destinoUrl });
await destino.connect();
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

try {
  await destino.query("SET TimeZone = 'UTC'");

  // ── Estrutura dos dois lados ───────────────────────────────────────────────
  const colsOrigem = (
    await origem.request().query<{ tabela: string; coluna: string; tipo: string; calculada: number }>(`
      SELECT c.TABLE_NAME AS tabela, c.COLUMN_NAME AS coluna, c.DATA_TYPE AS tipo,
             COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsComputed') AS calculada
      FROM INFORMATION_SCHEMA.COLUMNS c
      JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = 'dbo' AND t.TABLE_TYPE = 'BASE TABLE'
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`)
  ).recordset;
  const colsDestino = (
    await destino.query<{ tabela: string; coluna: string; tipo: string; gerada: boolean; identity: boolean; obrigatoria: boolean }>(`
      SELECT table_name AS tabela, column_name AS coluna, data_type AS tipo,
             is_generated = 'ALWAYS' AS gerada, is_identity = 'YES' AS identity,
             is_nullable = 'NO' AND column_default IS NULL AND is_identity = 'NO' AND is_generated = 'NEVER' AS obrigatoria
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`)
  ).rows;

  const porTabela = <T extends { tabela: string }>(linhas: T[]) => {
    const m = new Map<string, T[]>();
    for (const l of linhas) m.set(l.tabela, [...(m.get(l.tabela) ?? []), l]);
    return m;
  };
  const origemPorTabela = porTabela(colsOrigem);
  const destinoPorTabela = porTabela(colsDestino);

  const problemas: string[] = [];
  const tabelas = new Map<string, Tabela>();
  for (const [nome, cols] of origemPorTabela) {
    if (nome in IGNORADAS) continue;
    const dest = destinoPorTabela.get(nome);
    if (!dest) {
      problemas.push(`${nome}: não existe no destino (falta uma migração, ou acrescentar a IGNORADAS)`);
      continue;
    }
    const colunas: Coluna[] = [];
    for (const c of cols) {
      const d = dest.find((x) => x.coluna === c.coluna);
      if (!d) {
        problemas.push(`${nome}.${c.coluna}: não existe no destino`);
        continue;
      }
      if (Boolean(c.calculada) !== d.gerada) problemas.push(`${nome}.${c.coluna}: calculada num lado e no outro não`);
      colunas.push({ nome: c.coluna, tipoOrigem: c.tipo, tipoDestino: d.tipo, inserir: !d.gerada });
    }
    for (const d of dest) {
      if (!cols.some((c) => c.coluna === d.coluna) && d.obrigatoria)
        problemas.push(`${nome}.${d.coluna}: obrigatória no destino e não vem da origem`);
    }
    tabelas.set(nome, { nome, colunas, identity: dest.filter((d) => d.identity).map((d) => d.coluna) });
  }
  for (const nome of destinoPorTabela.keys()) {
    if (!tabelas.has(nome) && !SO_DESTINO.has(nome) && !problemas.some((p) => p.startsWith(`${nome}:`)))
      problemas.push(`${nome}: existe no destino mas não na origem`);
  }
  if (problemas.length) {
    console.error("\nOs schemas não batem:\n  " + problemas.join("\n  "));
    process.exit(1);
  }

  // ── Ordem pelas chaves estrangeiras ────────────────────────────────────────
  const fks = (
    await destino.query<{ filha: string; mae: string }>(`
      SELECT DISTINCT c.conrelid::regclass::text AS filha, c.confrelid::regclass::text AS mae
      FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid <> c.confrelid`)
  ).rows.map((r) => ({ filha: r.filha.replace(/"/g, ""), mae: r.mae.replace(/"/g, "") }));
  const ordem: string[] = [];
  const pendentes = new Set(tabelas.keys());
  while (pendentes.size) {
    const prontas = [...pendentes].filter((t) => !fks.some((f) => f.filha === t && pendentes.has(f.mae) && tabelas.has(f.mae)));
    if (!prontas.length) throw new Error(`Ciclo de chaves estrangeiras entre: ${[...pendentes].join(", ")}`);
    for (const t of prontas.sort()) {
      ordem.push(t);
      pendentes.delete(t);
    }
  }

  // ── Destino vazio ──────────────────────────────────────────────────────────
  const comDados: string[] = [];
  for (const nome of [...ordem, ...SO_DESTINO]) {
    const { rows } = await destino.query(`SELECT EXISTS (SELECT 1 FROM ${q(nome)}) AS tem`);
    if (rows[0].tem) comDados.push(nome);
  }
  if (comDados.length) {
    console.error(`\nO destino tem de estar vazio. Com dados: ${comDados.join(", ")}`);
    console.error("(em dev: npm run dev:utilizadores-teste -- --apagar)");
    process.exit(1);
  }

  // ── Cópia e verificação, numa transação ────────────────────────────────────
  const hash = (linhas: string[]) => createHash("sha256").update(linhas.sort().join("\n")).digest("hex");
  const relatorio: { tabela: string; origem: number; destino: number; ok: boolean }[] = [];

  await destino.query("BEGIN");
  for (const nome of ordem) {
    const t = tabelas.get(nome)!;
    const sel = t.colunas.map((c) => `${expressaoOrigem(c.nome, c.tipoOrigem)} AS [${c.nome}]`).join(", ");
    const linhas = (await origem.request().query(`SELECT ${sel} FROM [dbo].[${nome}]`)).recordset as Record<string, unknown>[];

    const transf = TRANSFORMACOES[nome] ?? {};
    for (const l of linhas) for (const [col, f] of Object.entries(transf)) l[col] = f(l[col]);

    const aInserir = t.colunas.filter((c) => c.inserir);
    for (let i = 0; i < linhas.length; i += LOTE) {
      const lote = linhas.slice(i, i + LOTE);
      const valores: unknown[] = [];
      const tuplos = lote.map((l) => {
        const ps = aInserir.map((c) => {
          valores.push(l[c.nome]);
          return `$${valores.length}`;
        });
        return `(${ps.join(", ")})`;
      });
      await destino.query(
        `INSERT INTO ${q(nome)} (${aInserir.map((c) => q(c.nome)).join(", ")}) VALUES ${tuplos.join(", ")}`,
        valores,
      );
    }

    for (const col of t.identity) {
      await destino.query(
        `SELECT setval(pg_get_serial_sequence($1, $2), m) FROM (SELECT max(${q(col)}) AS m FROM ${q(nome)}) x WHERE m IS NOT NULL`,
        [q(nome), col],
      );
    }

    const lidas = (
      await destino.query(`SELECT ${t.colunas.map((c) => `${q(c.nome)}::text AS ${q(c.nome)}`).join(", ")} FROM ${q(nome)}`)
    ).rows as Record<string, unknown>[];
    const forma = (l: Record<string, unknown>) => JSON.stringify(t.colunas.map((c) => canonico(l[c.nome], c.tipoDestino)));
    const ok = lidas.length === linhas.length && hash(lidas.map(forma)) === hash(linhas.map(forma));
    relatorio.push({ tabela: nome, origem: linhas.length, destino: lidas.length, ok });
  }

  // Passwords: do AspNetUsers para auth_contas, onde o login (Better Auth) as lê.
  const { rows: users } = await destino.query<{ id: string }>(
    `SELECT "Id" AS id FROM "AspNetUsers" WHERE "PasswordHash" IS NOT NULL`,
  );
  for (const u of users) {
    await destino.query(
      `INSERT INTO auth_contas (id, account_id, provider_id, user_id, password)
       SELECT $1, "Id", 'credential', "Id", "PasswordHash" FROM "AspNetUsers" WHERE "Id" = $2`,
      [randomUUID(), u.id],
    );
  }
  const { rows: contas } = await destino.query(
    `SELECT count(*)::int AS n FROM auth_contas a JOIN "AspNetUsers" u ON u."Id" = a.user_id AND u."PasswordHash" = a.password`,
  );
  const contasOk = contas[0].n === users.length;
  relatorio.push({ tabela: "auth_contas (das passwords)", origem: users.length, destino: contas[0].n, ok: contasOk });
  if (contasOk) await destino.query(`UPDATE "AspNetUsers" SET "PasswordHash" = NULL`);

  // ── Relatório ──────────────────────────────────────────────────────────────
  const largura = Math.max(...relatorio.map((r) => r.tabela.length));
  console.log(`\n${"tabela".padEnd(largura)}  origem  destino  checksum`);
  for (const r of relatorio)
    console.log(`${r.tabela.padEnd(largura)}  ${String(r.origem).padStart(6)}  ${String(r.destino).padStart(7)}  ${r.ok ? "ok" : "DIFERENTE"}`);
  for (const [nome, motivo] of Object.entries(IGNORADAS)) {
    if (!origemPorTabela.has(nome)) continue;
    const { recordset } = await origem.request().query(`SELECT COUNT(*) AS n FROM [dbo].[${nome}]`);
    console.log(`(ignorada) ${nome}: ${recordset[0].n} linhas — ${motivo}`);
  }

  const falhas = relatorio.filter((r) => !r.ok);
  if (falhas.length || simular) {
    await destino.query("ROLLBACK");
    if (falhas.length) {
      console.error(`\n${falhas.length} tabela(s) não bateram: nada foi gravado.`);
      process.exitCode = 1;
    } else {
      console.log("\nSimulação: tudo bateu. ROLLBACK, nada foi gravado.");
    }
  } else {
    await destino.query("COMMIT");
    console.log(`\nMigradas ${relatorio.length - 1} tabelas, todas a bater. COMMIT feito.`);
  }
} catch (e) {
  await destino.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await destino.end();
  await origem.close();
}
