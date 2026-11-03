import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";

describe("Money", () => {
  test("serializa com duas casas decimais", () => {
    const money = Money.from({
      amount: "25",
      currency: "BRL",
    });

    expect(money.toJSON()).toEqual({
      amount: "25.00",
      currency: "BRL",
    });
  });

  test("soma valores decimais com precisão e preserva o original", () => {
    const first = Money.from({
      amount: "0.10",
      currency: "BRL",
    });
    const second = Money.from({
      amount: "0.20",
      currency: "BRL",
    });

    const result = first.add(second);

    expect(result.toString()).toBe("0.30");
    expect(first.toString()).toBe("0.10");
    expect(second.toString()).toBe("0.20");
  });

  test("rejeita operações entre moedas diferentes", () => {
    const brl = Money.from({
      amount: "10.00",
      currency: "BRL",
    });
    const usd = Money.from({
      amount: "10.00",
      currency: "USD",
    });

    expect(() => brl.add(usd)).toThrow();
  });

  test.each([
    "",
    "NaN",
    "Infinity",
    "1e3",
    "1.001",
    "-1.00",
    "10,50",
  ])("rejeita a entrada inválida %j", (amount) => {
    expect(() =>
      Money.from({ amount, currency: "BRL" }),
    ).toThrow();
  });
});

describe("Money — operações e limites", () => {
  const brl = (amount: string): Money =>
    Money.from({ amount, currency: "BRL" });

  test("cria zero e verifica seu sinal", () => {
    const zero = Money.zero("BRL");

    expect(zero.toString()).toBe("0.00");
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  test("subtrai e permite diferença negativa sem alterar o original", () => {
    const original = brl("10.00");
    const result = original.subtract(brl("15.25"));

    expect(result.toString()).toBe("-5.25");
    expect(result.isNegative()).toBe(true);
    expect(original.toString()).toBe("10.00");
    expect(original.isPositive()).toBe(true);
  });

  test("inverte o sinal e preserva o original", () => {
    const original = brl("2.50");
    const negative = original.negate();

    expect(negative.toString()).toBe("-2.50");
    expect(negative.negate().equals(original)).toBe(true);
    expect(original.toString()).toBe("2.50");
  });

  test("compara valores monetários", () => {
    expect(brl("1").equals(brl("1.00"))).toBe(true);
    expect(brl("1").equals(brl("2"))).toBe(false);
    expect(brl("1").isLessThan(brl("2"))).toBe(true);
    expect(brl("2").isLessThan(brl("1"))).toBe(false);
  });

  test("rejeita conflito de moeda nos demais métodos", () => {
    const real = brl("1");
    const dollar = Money.from({
      amount: "1.00",
      currency: "USD",
    });

    expect(() => real.subtract(dollar)).toThrow();
    expect(() => real.isLessThan(dollar)).toThrow();
    expect(() => real.equals(dollar)).toThrow();
  });

  test("preserva centavos em valores acima da precisão segura de number", () => {
    const large = brl("9007199254740993.01");

    expect(large.add(brl("0.01")).toString())
      .toBe("9007199254740993.02");
  });

  test("aceita o limite e rejeita estouro nas operações", () => {
    const maximum = brl("999999999999999999.99");

    expect(maximum.toString()).toBe("999999999999999999.99");
    expect(() => maximum.add(brl("0.01"))).toThrow();
    expect(() => brl("1000000000000000000.00")).toThrow();
    expect(() =>
      maximum.negate().subtract(brl("0.01")),
    ).toThrow();
  });

  test.each(["1.005", "0.001", " 1.00", "1.00 ", "+1.00"])(
    "rejeita %j sem arredondar ou corrigir a entrada",
    (amount) => {
      expect(() => brl(amount)).toThrow();
    },
  );

  test.each(["", "brl", "XYZ"])(
    "rejeita moeda não suportada %j",
    (currency) => {
      expect(() =>
        Money.from({ amount: "1.00", currency }),
      ).toThrow();
    },
  );

  test("serializa corretamente com JSON.stringify", () => {
    expect(JSON.stringify(brl("25"))).toBe(
      '{"amount":"25.00","currency":"BRL"}',
    );
  });
});