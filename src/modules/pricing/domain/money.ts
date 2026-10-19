/**
 * Money: an integer count of minor units (paise). No floats anywhere in money paths (brief §5).
 * Every operation checks that the result is a safe integer, so a float can never sneak in.
 */
export type Currency = 'INR';

export class Money {
  private constructor(
    readonly paise: number,
    readonly currency: Currency = 'INR',
  ) {}

  static of(paise: number): Money {
    if (!Number.isSafeInteger(paise)) {
      throw new RangeError(`Money must be a safe integer number of paise, got ${paise}`);
    }
    return new Money(paise);
  }

  static zero(): Money {
    return new Money(0);
  }

  /** Whole rupees to Money, e.g. Money.rupees(1499) is 149900 paise. */
  static rupees(rupees: number): Money {
    return Money.of(rupees * 100);
  }

  add(other: Money): Money {
    return Money.of(this.paise + other.paise);
  }

  sub(other: Money): Money {
    return Money.of(this.paise - other.paise);
  }

  /** Multiply by a whole quantity. */
  times(quantity: number): Money {
    if (!Number.isInteger(quantity)) throw new RangeError('quantity must be an integer');
    return Money.of(this.paise * quantity);
  }

  isZero(): boolean {
    return this.paise === 0;
  }

  isNegative(): boolean {
    return this.paise < 0;
  }

  equals(other: Money): boolean {
    return this.paise === other.paise;
  }

  gt(other: Money): boolean {
    return this.paise > other.paise;
  }

  lt(other: Money): boolean {
    return this.paise < other.paise;
  }

  static min(a: Money, b: Money): Money {
    return a.lt(b) ? a : b;
  }

  static max(a: Money, b: Money): Money {
    return a.gt(b) ? a : b;
  }

  /**
   * Split this amount across `weights` proportionally using integer arithmetic only. The parts always
   * add up to exactly this amount: the remainder is handed out one paisa at a time to the largest
   * fractional shares (largest-remainder method), ties broken by lowest index. Used to spread
   * discounts and shipping across order lines.
   */
  allocate(weights: number[]): Money[] {
    if (weights.length === 0) throw new RangeError('weights must not be empty');
    if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
      throw new RangeError('weights must be non-negative safe integers');
    }
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) throw new RangeError('at least one weight must be positive');
    const sign = this.paise < 0 ? -1 : 1;
    const amount = Math.abs(this.paise);
    // BigInt keeps amount * weight exact even when it exceeds 2^53.
    const shares = weights.map((w) => (BigInt(amount) * BigInt(w)) / BigInt(total));
    const remainders = weights.map((w, i) => ({
      i,
      rem: (BigInt(amount) * BigInt(w)) % BigInt(total),
    }));
    let leftover = amount - shares.reduce((a, b) => a + Number(b), 0);
    remainders.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
    const out = shares.map((s) => Number(s));
    for (const { i } of remainders) {
      if (leftover === 0) break;
      out[i] = (out[i] ?? 0) + 1;
      leftover -= 1;
    }
    return out.map((p) => Money.of(sign * p));
  }
}

/** Indian digit grouping (12,34,567) for a non-negative integer string. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/** "15,000" or "1,499.50": whole rupees without decimals, otherwise two decimals. */
export function formatRupees(money: Money): string {
  const abs = Math.abs(money.paise);
  const rupees = Math.trunc(abs / 100);
  const paise = abs % 100;
  const body = groupIndian(String(rupees)) + (paise ? `.${String(paise).padStart(2, '0')}` : '');
  return money.paise < 0 ? `-${body}` : body;
}

/** The storefront price style used throughout the original design: "[ RS. 15,000 ]". */
export function formatBracketPrice(money: Money): string {
  return `[ RS. ${formatRupees(money)} ]`;
}
