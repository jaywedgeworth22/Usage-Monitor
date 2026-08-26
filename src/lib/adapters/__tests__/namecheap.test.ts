import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractNamecheapErrors,
  fetchUsage,
  parseBalancesXml,
  parseDomainsXml,
} from "../namecheap";

const SAMPLE_BALANCES_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <Warnings />
  <RequestedCommand>namecheap.users.getBalances</RequestedCommand>
  <CommandResponse Type="namecheap.users.getBalances">
    <UserGetBalancesResult Currency="USD" AvailableBalance="48.50" AccountBalance="48.50" EarnedAmount="0.00" WithdrawableAmount="48.50" FundsRequiredForAutoRenew="12.00" />
  </CommandResponse>
  <Server>SERVER-NAME</Server>
  <GMTTimeDifference>--5:00</GMTTimeDifference>
  <ExecutionTime>0.05</ExecutionTime>
</ApiResponse>`;

const SAMPLE_DOMAINS_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <Warnings />
  <RequestedCommand>namecheap.domains.getList</RequestedCommand>
  <CommandResponse Type="namecheap.domains.getList">
    <DomainGetListResult>
      <Domain ID="1001" Name="jays.services" User="jaywedgeworth" Created="01/15/2024" Expires="01/15/2027" IsExpired="false" IsLocked="false" AutoRenew="true" WhoisGuard="ENABLED" />
      <Domain ID="1002" Name="socratictrade.com" User="jaywedgeworth" Created="02/10/2024" Expires="02/10/2026" IsExpired="false" IsLocked="false" AutoRenew="true" WhoisGuard="ENABLED" />
    </DomainGetListResult>
    <Paging>
      <TotalItems>2</TotalItems>
      <CurrentPage>1</CurrentPage>
      <PageSize>100</PageSize>
    </Paging>
  </CommandResponse>
  <Server>SERVER-NAME</Server>
  <GMTTimeDifference>--5:00</GMTTimeDifference>
  <ExecutionTime>0.08</ExecutionTime>
</ApiResponse>`;

const SAMPLE_ERROR_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response">
  <Errors>
    <Error Number="1011150">Parameter ApiKey is invalid</Error>
    <Error Number="1011151">Client IP is not whitelisted</Error>
  </Errors>
  <Warnings />
  <RequestedCommand>namecheap.users.getBalances</RequestedCommand>
  <Server>SERVER-NAME</Server>
</ApiResponse>`;

describe("namecheap adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses balance XML attributes correctly", () => {
    const balances = parseBalancesXml(SAMPLE_BALANCES_XML);
    expect(balances).toEqual({
      currency: "USD",
      availableBalance: 48.5,
      accountBalance: 48.5,
      earnedAmount: 0,
      withdrawableAmount: 48.5,
      fundsRequiredForAutoRenew: 12,
    });
  });

  it("parses domain list XML correctly", () => {
    const { domains, totalItems } = parseDomainsXml(SAMPLE_DOMAINS_XML);
    expect(totalItems).toBe(2);
    expect(domains).toHaveLength(2);
    expect(domains[0]).toMatchObject({
      id: "1001",
      name: "jays.services",
      user: "jaywedgeworth",
      autoRenew: true,
      isExpired: false,
    });
  });

  it("extracts error messages from Namecheap XML responses", () => {
    const errors = extractNamecheapErrors(SAMPLE_ERROR_XML);
    expect(errors).toEqual([
      "Parameter ApiKey is invalid",
      "Client IP is not whitelisted",
    ]);
  });

  it("fetches usage, balance, and domain inventory", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("namecheap.users.getBalances")) {
          return Promise.resolve(
            new Response(SAMPLE_BALANCES_XML, {
              status: 200,
              headers: { "content-type": "text/xml" },
            })
          );
        }
        if (url.includes("namecheap.domains.getList")) {
          return Promise.resolve(
            new Response(SAMPLE_DOMAINS_XML, {
              status: 200,
              headers: { "content-type": "text/xml" },
            })
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      })
    );

    const result = await fetchUsage("mock-key", {
      apiUser: "jaywedgeworth",
      clientIp: "99.44.91.248",
    });

    expect(result.balance).toBe(48.5);
    expect(result.totalRequests).toBe(2);
    expect(result.credits).toBe(48.5);
    expect((result.rawData as any).domains).toHaveLength(2);
  });
});
