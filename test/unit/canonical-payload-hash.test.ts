import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  canonicalPayloadHash,
} from "../../src/application/canonical-payload-hash";

describe("Hash canônico", () => {
  test("ordena as chaves também nos objetos internos", () => {
    const first = {
      providerId: "provider-a",
      money: { currency: "BRL", amount: "25.00" },
    };

    const second = {
      money: { amount: "25.00", currency: "BRL" },
      providerId: "provider-a",
    };

    expect(canonicalPayloadHash(first))
      .toBe(canonicalPayloadHash(second));

    expect(canonicalJson(first)).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"},"providerId":"provider-a"}',
    );
  });

  test("alterar o valor monetário altera o hash", () => {
    expect(
      canonicalPayloadHash({
        money: { amount: "25.00", currency: "BRL" },
      }),
    ).not.toBe(
      canonicalPayloadHash({
        money: { amount: "26.00", currency: "BRL" },
      }),
    );
  });

  test("preserva a ordem dos arrays", () => {
    expect(canonicalPayloadHash(["BET", "WIN"]))
      .not.toBe(canonicalPayloadHash(["WIN", "BET"]));
  });

  test("gera SHA-256 hexadecimal com 64 caracteres", () => {
    expect(canonicalPayloadHash({ kind: "BET" }))
      .toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejeita números não finitos", () => {
    expect(() => canonicalJson({ value: Infinity })).toThrow();
    expect(() => canonicalJson({ value: NaN })).toThrow();
  });
});