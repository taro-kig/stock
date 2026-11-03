import { describe, expect, it } from "vitest";
import { isJpTradingDay, jpHoliday, jpMarketHolidays, jpTradingDays } from "../src/util/jpCalendar.ts";

describe("TSE calendar", () => {
  it("matches the published 2025 and 2026 holidays (weekdays only)", () => {
    expect([...jpMarketHolidays(2025).keys()].sort()).toEqual([
      "2025-01-01", "2025-01-02", "2025-01-03", "2025-01-13", "2025-02-11", "2025-02-24", "2025-03-20", "2025-04-29",
      "2025-05-05", "2025-05-06", "2025-07-21", "2025-08-11", "2025-09-15", "2025-09-23", "2025-10-13", "2025-11-03", "2025-11-24", "2025-12-31",
    ]);
    expect([...jpMarketHolidays(2026).keys()].sort()).toEqual([
      "2026-01-01", "2026-01-02", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29",
      "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23",
      "2026-10-12", "2026-11-03", "2026-11-23", "2026-12-31",
    ]);
    expect(jpHoliday("2026-09-22")).toBe("国民の休日");
    expect(jpHoliday("2026-05-06")).toBe("振替休日");
  });

  it("trading days skip weekends and holidays", () => {
    expect(isJpTradingDay("2026-11-02")).toBe(true);
    expect(isJpTradingDay("2026-11-03")).toBe(false);
    expect(jpTradingDays("2026-12-29", "2027-01-06")).toEqual(["2026-12-29", "2026-12-30", "2027-01-04", "2027-01-05", "2027-01-06"]);
  });
});
