import * as crypto from "crypto";
import { kInt, parseKeetaJson, stringifyKeeta } from "../keeta-json";
import {
  keetaSigBase,
  keetaSign,
  keetaSortedParams,
  verifyKeetaWebhookSig,
} from "../keeta-signature";

// The one thing in this integration verified against Keeta themselves: their
// Authorization Guide works an example through to a published signature.

describe("keetaSign — Keeta's worked example", () => {
  const url = "https://open.mykeeta.com/api/open/product/shopcategory/update";
  const shopCategory = { id: 123, name: "test", type: 0, description: null };

  it("reproduces their published sig byte for byte", () => {
    const sig = keetaSign(
      url,
      { appId: 123, shopId: 123, accessToken: "abc", shopCategory, timestamp: 1682566749 },
      "abc",
    );
    expect(sig).toBe("48eb6d562bb0673e3db753831f032be237fc19d1e5c33fcb5386d89c0eebca86");
  });

  it("builds exactly their pre-encryption string (url ? sorted params, secret appended bare)", () => {
    expect(
      keetaSigBase(url, { appId: 123, shopId: 123, accessToken: "abc", shopCategory, timestamp: 1682566749 }, "abc"),
    ).toBe(
      'https://open.mykeeta.com/api/open/product/shopcategory/update?accessToken=abc&appId=123&shopCategory={"id":123,"name":"test","type":0,"description":null}&shopId=123&timestamp=1682566749abc',
    );
  });

  it("signs a 64-bit id sent as KeetaInt the same as the number", () => {
    const a = keetaSign(url, { orderViewId: kInt("756823555555859"), appId: 1 }, "s");
    const b = keetaSign(url, { orderViewId: 756823555555859, appId: 1 }, "s");
    expect(a).toBe(b);
  });
});

describe("keetaSortedParams", () => {
  it("excludes sig, sorts in ASCII order (uppercase before lowercase), and keeps empties and nulls", () => {
    expect(keetaSortedParams({ b: "", sig: "x", a: null, Z: 1 })).toBe("Z=1&a=null&b=");
  });

  it("drops undefined — an absent key is not a null one", () => {
    expect(keetaSortedParams({ a: 1, b: undefined })).toBe("a=1");
  });

  it("signs arrays of objects as the same compact JSON that goes on the wire", () => {
    const list = [{ cipherText: "ENC_1" }];
    expect(keetaSortedParams({ cipherInfos: list })).toBe(`cipherInfos=${stringifyKeeta(list)}`);
  });
});

describe("verifyKeetaWebhookSig — the undocumented recipe", () => {
  const secret = "s3cret";
  const envelope = {
    eventId: 1002,
    appId: 3762772727,
    messageId: "1930106161957212198",
    shopId: 145541,
    message: '{"opTime":1749008143025,"orderViewId":553440887574627,"shopId":145541,"status":30}',
    timestamp: 1749008143,
  };
  const sorted = keetaSortedParams(envelope);
  const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

  it("recognises the request recipe applied to OUR webhook URL", () => {
    const url = "https://api.example.com/api/v1/integrations/keeta/webhook";
    const sig = hash(`${url}?${sorted}${secret}`);
    const r = verifyKeetaWebhookSig({ ...envelope, sig }, secret, [url]);
    expect(r.ok).toBe(true);
    expect(r.variant).toContain("url?params+secret");
  });

  it("recognises a URL-less variant", () => {
    const sig = hash(`${sorted}${secret}`);
    expect(verifyKeetaWebhookSig({ ...envelope, sig }, secret, []).variant).toBe("params+secret");
  });

  it("rejects a sig made with another secret", () => {
    const sig = hash(`${sorted}other`);
    expect(verifyKeetaWebhookSig({ ...envelope, sig }, secret, []).ok).toBe(false);
  });

  it("never throws on a missing sig", () => {
    expect(verifyKeetaWebhookSig({ ...envelope }, secret, []).ok).toBe(false);
  });
});

describe("parseKeetaJson — 64-bit ids", () => {
  it("keeps an id past 2^53 exact, as a string", () => {
    const v = parseKeetaJson<{ orderViewId: string }>('{"orderViewId":12345678901234567}');
    expect(v.orderViewId).toBe("12345678901234567");
  });

  it("leaves ordinary numbers as numbers", () => {
    const v = parseKeetaJson<any>('{"price":4600,"lat":24.123456,"neg":-12,"exp":1e3}');
    expect(v).toEqual({ price: 4600, lat: 24.123456, neg: -12, exp: 1000 });
  });

  it("does not touch digits inside strings — Keeta nest whole JSON documents in string fields", () => {
    const inner = '{"orderViewId":12345678901234567}';
    const v = parseKeetaJson<any>(JSON.stringify({ message: inner }));
    expect(v.message).toBe(inner);
  });

  it("handles escaped quotes inside strings", () => {
    const v = parseKeetaJson<any>('{"a":"x\\"12345678901234567\\"","b":12345678901234567}');
    expect(v).toEqual({ a: 'x"12345678901234567"', b: "12345678901234567" });
  });
});

describe("stringifyKeeta", () => {
  it("prints a KeetaInt as a bare number", () => {
    expect(stringifyKeeta({ orderViewId: kInt("12345678901234567") })).toBe('{"orderViewId":12345678901234567}');
  });

  it("is compact and keeps insertion order", () => {
    expect(stringifyKeeta({ b: 1, a: [1, "x", null] })).toBe('{"b":1,"a":[1,"x",null]}');
  });
});
