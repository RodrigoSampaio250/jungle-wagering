import Decimal from "decimal.js";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends Error {
  constructor() {
    super("Valor monetário inválido.");
    this.name = "InvalidMoneyError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor() {
    super("Operação entre moedas diferentes.");
    this.name = "CurrencyMismatchError";
  }
}

// Configuração isolada para não alterar outros usos de Decimal.
const ExactDecimal = Decimal.clone({ precision: 100 });

// Limite que também adotaremos na persistência: NUMERIC(20, 2).
const MAX_AMOUNT = new ExactDecimal("999999999999999999.99");

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (
      typeof props.amount !== "string" ||
      !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(props.amount)
    ) {
      throw new InvalidMoneyError();
    }

    Money.assertCurrency(props.currency);

    return Money.fromDecimal(
      new ExactDecimal(props.amount),
      props.currency,
    );
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.fromDecimal(
      this.value.plus(other.value),
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.fromDecimal(
      this.value.minus(other.value),
      this.currency,
    );
  }

  negate(): Money {
    return Money.fromDecimal(
      this.value.negated(),
      this.currency,
    );
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan("0");
  }

  isNegative(): boolean {
    return this.value.lessThan("0");
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private static fromDecimal(
    value: Decimal,
    currency: string,
  ): Money {
    if (
      !value.isFinite() ||
      value.decimalPlaces() > 2 ||
      value.abs().greaterThan(MAX_AMOUNT)
    ) {
      throw new InvalidMoneyError();
    }

    return new Money(value, currency);
  }

  private static assertCurrency(currency: string): void {
    // Moedas aceitas neste desafio, ambas com escala de 2 casas.
    if (currency !== "BRL" && currency !== "USD") {
      throw new InvalidMoneyError();
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError();
    }
  }
}