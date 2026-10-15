// Ligação à BD. Na Neon usa o driver WebSocket (Pool), que suporta transações interativas:
// o apuramento lê, apaga e reinsere linhas numa só transação, e o driver HTTP não o permite.
// Em localhost (Postgres em Docker, ETL e testes) usa o node-postgres, com a mesma API.
import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A BD ou uma transação aberta: o que as funções que gravam recebem. */
export type Executor = Pick<Db, "select" | "insert" | "update" | "delete" | "execute" | "transaction" | "query">;

function criar(): Db {
  const url = process.env.DATABASE_URL!;
  const local = url && ["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname);
  if (local) return drizzlePg(new pg.Pool({ connectionString: url, max: 5 }), { schema });
  // A API do drizzle é a mesma nos dois drivers; o tipo do node-postgres serve para ambos.
  return drizzleNeon(new NeonPool({ connectionString: url, idleTimeoutMillis: 10_000 }), { schema }) as unknown as Db;
}

export const db = criar();
