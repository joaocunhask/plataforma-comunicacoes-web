// Mostra a que base de dados o .env.local aponta e quantas tabelas e migrações tem.
// Só leitura. Uso: npm run db:status
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Falta DATABASE_URL no .env.local");

const sql = neon(url);
const [info] = await sql`
  select current_database() as db,
         split_part(version(), ' ', 2) as versao,
         (select count(*)::int from information_schema.tables where table_schema = 'public') as tabelas,
         to_regclass('drizzle.__drizzle_migrations') is not null as tem_migracoes`;
const migracoes = info.tem_migracoes
  ? (await sql`select count(*)::int as n from drizzle.__drizzle_migrations`)[0].n
  : 0;

console.log(`host:       ${new URL(url).host}`);
console.log(`bd:         ${info.db} (Postgres ${info.versao})`);
console.log(`tabelas:    ${info.tabelas}`);
console.log(`migrações:  ${migracoes}`);
