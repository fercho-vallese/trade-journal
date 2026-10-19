import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { parseFlexStatement } from "@luxalgo/broker-sdk/adapters";

const scratch = mkdtempSync(join(tmpdir(), "journal-ibkr-multipliers-"));
vi.stubEnv("JOURNAL_DATA_DIR", scratch);
vi.stubEnv("JOURNAL_PASSWORD", "");
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
const { db, accounts, executions, trades, settings } = await import("../src/db");
const { encryptJson } = await import("../src/server/crypto");
const { getMultipliers, setSetting } = await import("../src/server/settings");
const { brokerMultipliers, syncAccount } = await import("../src/server/sync");
const { insertExecutions } = await import("../src/server/executions");

// Synthetic statement: never commit a real Flex report, this repository is public.
const statement = readFileSync(
  new URL("./fixtures/ibkr-flex-multipliers.xml", import.meta.url),
  "utf8",
);
const OPTION = "TEST  261016C00100000";
const EXPIRED_PUT = "TEST  260918P00090000";
const FUTURE_OPTION = "XYZ   261016C6000";

const addAccount = (id: string, kind: "sync" | "manual") =>
  db
    .insert(accounts)
    .values({
      id,
      name: id,
      kind,
      ...(kind === "sync"
        ? {
            broker: "ibkr-flex",
            credentialsEnc: encryptJson({ flexToken: "test-only", flexQueryId: "test-only" }),
          }
        : {}),
      createdAt: "2026-01-01",
    })
    .run();
const mockStatement = (content: string) =>
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/SendRequest?"))
        return new Response(
          "<FlexStatementResponse><Status>Success</Status><ReferenceCode>test</ReferenceCode></FlexStatementResponse>",
        );
      if (url.includes("/GetStatement?")) return new Response(content);
      throw new Error(`Unexpected network request: ${url}`);
    }),
  );
const grossBySymbol = (accountId: string) =>
  Object.fromEntries(
    db
      .select()
      .from(trades)
      .where(eq(trades.accountId, accountId))
      .all()
      .map((trade) => [trade.symbol, trade.grossPnl]),
  );

beforeEach(() => {
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(accounts).run();
  db.delete(settings).run();
  addAccount("ibkr", "sync");
  setSetting("importTimeZone", "America/New_York");
  mockStatement(statement);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  db.$client.close();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("IBKR Flex contract multipliers", () => {
  it("parses each fill's multiplier and asset class", () => {
    const parsed = parseFlexStatement(statement, { statementTimeZone: "America/New_York" });
    const bySymbol = new Map(parsed.trades.map((trade) => [trade.symbol, trade]));
    expect(bySymbol.get("TEST")).toMatchObject({ multiplier: 1, assetClass: "equity" });
    expect(bySymbol.get(OPTION)).toMatchObject({ multiplier: 100, assetClass: "option" });
    expect(bySymbol.get(FUTURE_OPTION)).toMatchObject({ multiplier: 50, assetClass: "option" });
    expect(bySymbol.get("TSTZ6")).toMatchObject({ multiplier: 5, assetClass: "futures" });
    expect(bySymbol.get("EUR.USD")).toMatchObject({ multiplier: 1, assetClass: "forex" });
    // The zero-price expiration is still dropped, as before the patch.
    expect(parsed.trades).toHaveLength(12);
  });

  it("saves broker multipliers, keeps user values, and reprices every account", async () => {
    setSetting("multipliers", JSON.stringify({ SAVZ6: 2 }));
    addAccount("manual", "manual");
    insertExecutions(
      "manual",
      [
        {
          symbol: "TSTZ6",
          side: "buy",
          quantity: 1,
          price: 6000,
          fee: 0,
          executedAt: "2026-09-01T14:00:00.000Z",
        },
        {
          symbol: "TSTZ6",
          side: "sell",
          quantity: 1,
          price: 6020,
          fee: 0,
          executedAt: "2026-09-01T15:00:00.000Z",
        },
      ],
      "manual",
    );
    expect(grossBySymbol("manual")).toEqual({ TSTZ6: 20 });

    const outcome = await syncAccount("ibkr");
    expect(outcome).toMatchObject({ inserted: 12, skipped: 0, multipliersAdded: 4 });
    expect(getMultipliers()).toEqual({
      SAVZ6: 2,
      [OPTION]: 100,
      [EXPIRED_PUT]: 100,
      [FUTURE_OPTION]: 50,
      TSTZ6: 5,
    });
    expect(grossBySymbol("ibkr")).toMatchObject({
      TEST: 50,
      [OPTION]: 100,
      [FUTURE_OPTION]: 100,
      TSTZ6: 50,
      SAVZ6: 2,
    });
    expect(grossBySymbol("manual")).toEqual({ TSTZ6: 100 });
    const classes = Object.fromEntries(
      db
        .select()
        .from(executions)
        .where(eq(executions.accountId, "ibkr"))
        .all()
        .map((fill) => [fill.symbol, fill.assetClass]),
    );
    expect(classes).toMatchObject({
      TEST: "equity",
      [OPTION]: "option",
      [FUTURE_OPTION]: "option",
      TSTZ6: "futures",
      "EUR.USD": "forex",
    });

    const history = {
      executions: db.select().from(executions).all(),
      trades: db.select().from(trades).all(),
    };
    expect(await syncAccount("ibkr")).toMatchObject({
      inserted: 0,
      duplicates: 12,
      multipliersAdded: 0,
    });
    expect(db.select().from(executions).all()).toEqual(history.executions);
    expect(db.select().from(trades).all()).toEqual(history.trades);
  });

  it("leaves settings untouched when the statement has no multipliers", async () => {
    mockStatement(statement.replace(/ multiplier="[^"]*"/g, ""));
    expect(await syncAccount("ibkr")).toMatchObject({ inserted: 12, multipliersAdded: 0 });
    expect(getMultipliers()).toEqual({});
    expect(grossBySymbol("ibkr")[OPTION]).toBe(1);
  });

  it("ignores multipliers of one, conflicting reports and saved symbols", () => {
    expect(
      brokerMultipliers(
        [
          { symbol: "A", multiplier: 1 },
          { symbol: "B", multiplier: 100 },
          { symbol: "B", multiplier: 100 },
          { symbol: "C", multiplier: 50 },
          { symbol: "C", multiplier: 5 },
          { symbol: "D", multiplier: 20 },
          { symbol: "E" },
          { symbol: "F", multiplier: 0 },
        ],
        { D: 2 },
      ),
    ).toEqual({ B: 100 });
  });
});
