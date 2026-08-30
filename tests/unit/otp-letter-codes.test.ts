import { describe, expect, it } from "vitest";
import { extractOtpCode } from "../../src/gmail/verificationParsers.js";
import { chainVerificationCodeProviders } from "../../src/verification/codeProviders.js";

/**
 * Night19 #43 (2026-08-30, neuralink, after a real submit click): Greenhouse's
 * "Security code for your application to <Company>" mail carries EIGHT
 * mixed-case LETTERS — "…use the following code to finish your application:
 * aBCdefGh". The digit-only parser returned null and the click parked.
 * Shapes below are masked copies of the live mail. UNIT_CONFIRMED.
 */
describe("extractOtpCode — letter / alphanumeric codes", () => {
  const GH = (code: string) =>
    `Hi Shubham, Please use the following code to finish your application: ${code} Thank you for your time, Neuralink Hiring Team. © 2026 Greenhouse 12 Main St, San Francisco, CA 94105, USA`;

  it("reads Greenhouse's 8-letter mixed-case code after 'code to finish your application:'", () => {
    expect(extractOtpCode("Security code for your application to Neuralink", GH("aBCdefGh"))).toBe("aBCdefGh");
  });

  it("harder: alphanumeric codes, 'code is', and uppercase-with-digit all parse", () => {
    expect(extractOtpCode("", "Your verification code is X7K2P9QA. It expires in 10 minutes.")).toBe("X7K2P9QA");
    expect(extractOtpCode("", "Security code: k4mN8pQ2")).toBe("k4mN8pQ2");
    expect(extractOtpCode("", "Enter this one-time code to continue: AB12CD34")).toBe("AB12CD34");
  });

  it("digit codes still win, and the email local part is never a code", () => {
    expect(extractOtpCode("Your code", "Your verification code is 482193. Sent to skale072007@gmail.com")).toBe("482193");
    expect(extractOtpCode("", "code sent to skale072007@gmail.com")).toBeNull();
  });

  it("prose after 'code:' that is a plain word is never a code", () => {
    expect(extractOtpCode("", "Your code: below you will find instructions")).toBeNull();
    expect(extractOtpCode("", "CODE: EXPIRED, request another one")).toBeNull();
    expect(extractOtpCode("", "code is required to continue")).toBeNull();
  });

  it("the footer's street number and year are not codes", () => {
    expect(extractOtpCode("Security code for your application to Neuralink", GH("aBCdefGh"))).not.toBe("94105");
  });
});

describe("chainVerificationCodeProviders — a throwing provider is skipped", () => {
  it("Outlook UNAUTHENTICATED does not abort the chain; the next provider's code wins", async () => {
    const chain = chainVerificationCodeProviders([
      async () => {
        throw new Error("outlook session invalid (UNAUTHENTICATED): re-run login:outlook");
      },
      async () => ({ code: "aBCdefGh", source: "gmail" }),
    ]);
    await expect(chain({ requestedAt: new Date().toISOString(), emailHint: null })).resolves.toEqual({
      code: "aBCdefGh",
      source: "gmail",
    });
  });

  it("all providers dry or throwing ⇒ null, never a throw", async () => {
    const chain = chainVerificationCodeProviders([
      async () => {
        throw new Error("boom");
      },
      async () => null,
    ]);
    await expect(chain({ requestedAt: new Date().toISOString(), emailHint: null })).resolves.toBeNull();
  });
});
