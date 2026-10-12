import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// O mesmo ficheiro que o Next.js lê em dev.
config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
