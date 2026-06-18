import { describe, it, expect } from "vitest";
import pg from "pg";
import { PostgresRoadmapSource } from "../../src/integrations/roadmapPostgres.js";

const DB = process.env.DATABASE_URL;

// Exercises the REAL Postgres-backed roadmap source. Skips when DATABASE_URL is unset.
describe.skipIf(!DB)("PostgresRoadmapSource — live database", () => {
  it("reads approved roadmap targets from the table", async () => {
    const pool = new pg.Pool({ connectionString: DB });
    const customer = `Acme-${Date.now()}`;
    try {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS roadmap (customer TEXT NOT NULL, subject_canonical TEXT NOT NULL, target_date DATE NOT NULL, PRIMARY KEY (customer, subject_canonical))",
      );
      await pool.query(
        "INSERT INTO roadmap (customer, subject_canonical, target_date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [customer, "SSO_LOGIN_BUG", "2026-06-30"],
      );

      const entries = await new PostgresRoadmapSource({ pool }).list();
      const mine = entries.find((e) => e.customer === customer);
      expect(mine).toBeDefined();
      expect(mine?.subject_canonical).toBe("SSO_LOGIN_BUG");
      expect(mine?.targetDate).toBe("2026-06-30"); // DATE → 'YYYY-MM-DD'
    } finally {
      await pool.query("DELETE FROM roadmap WHERE customer = $1", [customer]);
      await pool.end();
    }
  });
});
