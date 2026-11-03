/**
 * Stocks used only to *measure* factors (eval.factors), never traded. Roughly the S&P 100 as of
 * 2025 — large, liquid US companies across every sector. Not the official index membership.
 *
 * Caveat (survivorship bias): these are companies that are large today; measuring the past on
 * them flatters factors that pick past winners (momentum, 52-week high) a little. The comparison
 * between factors is still informative; absolute numbers should be read conservatively.
 * Override with `research.universe` in config.yaml.
 */
export const RESEARCH_UNIVERSE_US: Record<string, string> = Object.fromEntries(
  Object.entries({
    tech: "AAPL MSFT ORCL CRM ADBE ACN IBM CSCO INTU NOW",
    semis: "NVDA AVGO AMD QCOM TXN INTC MU AMAT LRCX ADI",
    communication: "GOOGL META NFLX DIS CMCSA T VZ TMUS CHTR",
    consumer: "AMZN TSLA HD MCD NKE SBUX LOW BKNG TJX GM",
    staples: "WMT COST PG KO PEP PM MO MDLZ CL TGT",
    healthcare: "LLY UNH JNJ ABBV MRK PFE TMO ABT DHR AMGN BMY GILD MDT CVS ISRG",
    financials: "JPM BAC WFC GS MS C BLK SCHW AXP V MA BRK.B PYPL USB COF MET AIG BK",
    energy: "XOM CVX COP",
    industrials: "CAT GE HON UNP UPS RTX LMT BA DE MMM GD FDX EMR",
    materials: "LIN DOW",
    utilities: "NEE DUK SO",
    real_estate: "AMT SPG",
  }).flatMap(([sector, list]) => list.split(" ").map((t) => [t, sector])),
);
