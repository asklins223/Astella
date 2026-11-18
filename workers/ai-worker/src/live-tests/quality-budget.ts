export class QualityRequestBudgetExceeded extends Error {
  constructor() {
    super("live quality request budget exhausted");
    this.name = "QualityRequestBudgetExceeded";
  }
}

/** A live quality run must have an explicit, bounded request budget. */
export function createQualityRequestBudget(raw: string | undefined, variable = "LIVE_QUALITY_MAX_REQUESTS") {
  const max = Number(raw);
  if (!raw || !Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error(`${variable} must be an integer from 1 to 100`);
  }
  let used = 0;
  return {
    max,
    reserve() {
      if (used >= max) throw new QualityRequestBudgetExceeded();
      used++;
    },
    get used() { return used; },
  };
}
