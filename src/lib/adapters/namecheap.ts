import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export interface NamecheapDomainRecord {
  id: string;
  name: string;
  user?: string;
  created?: string;
  expires?: string;
  isExpired?: boolean;
  isLocked?: boolean;
  autoRenew?: boolean;
  whoisGuard?: string;
}

export interface NamecheapBalances {
  currency: string;
  availableBalance: number | null;
  accountBalance: number | null;
  earnedAmount: number | null;
  withdrawableAmount: number | null;
  fundsRequiredForAutoRenew: number | null;
}

/**
 * Parses XML attributes from a given tag string into a key-value map.
 */
function parseXmlAttributes(tagString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(tagString)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}

/**
 * Extracts error messages from Namecheap XML API response.
 */
export function extractNamecheapErrors(xml: string): string[] {
  const errors: string[] = [];
  const errorRegex = /<Error[^>]*>([^<]+)<\/Error>/gi;
  let match: RegExpExecArray | null;
  while ((match = errorRegex.exec(xml)) !== null) {
    const msg = match[1]?.trim();
    if (msg) errors.push(msg);
  }
  return errors;
}

/**
 * Parses the UserGetBalancesResult element from XML response.
 */
export function parseBalancesXml(xml: string): NamecheapBalances | null {
  const match = /<UserGetBalancesResult\b([^>]*)\/?>/i.exec(xml);
  if (!match) return null;

  const attrs = parseXmlAttributes(match[1]);
  return {
    currency: attrs.Currency || "USD",
    availableBalance: parseNumber(attrs.AvailableBalance),
    accountBalance: parseNumber(attrs.AccountBalance),
    earnedAmount: parseNumber(attrs.EarnedAmount),
    withdrawableAmount: parseNumber(attrs.WithdrawableAmount),
    fundsRequiredForAutoRenew: parseNumber(attrs.FundsRequiredForAutoRenew),
  };
}

/**
 * Parses domain items from DomainGetListResult XML response.
 */
export function parseDomainsXml(
  xml: string
): { domains: NamecheapDomainRecord[]; totalItems: number | null } {
  const domains: NamecheapDomainRecord[] = [];
  const domainRegex = /<Domain\b([^>]*)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = domainRegex.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(match[1]);
    if (attrs.Name) {
      domains.push({
        id: attrs.ID || attrs.Name,
        name: attrs.Name,
        user: attrs.User,
        created: attrs.Created,
        expires: attrs.Expires,
        isExpired: attrs.IsExpired?.toLowerCase() === "true",
        isLocked: attrs.IsLocked?.toLowerCase() === "true",
        autoRenew: attrs.AutoRenew?.toLowerCase() === "true",
        whoisGuard: attrs.WhoisGuard,
      });
    }
  }

  const pagingMatch = /<TotalItems>(\d+)<\/TotalItems>/i.exec(xml);
  const totalItems = pagingMatch ? Number.parseInt(pagingMatch[1], 10) : domains.length;

  return { domains, totalItems };
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const trimmedKey = apiKey?.trim();
  if (!trimmedKey) {
    configurationError("apiKey is required for Namecheap");
  }

  const apiUser = (
    (config?.apiUser as string | undefined) ||
    (config?.userName as string | undefined) ||
    (config?.username as string | undefined) ||
    process.env.NAMECHEAP_API_USER ||
    ""
  ).trim();

  if (!apiUser) {
    configurationError("apiUser (Namecheap Account Username) is required in config or NAMECHEAP_API_USER env");
  }

  const clientIp = (
    (config?.clientIp as string | undefined) ||
    (config?.clientIP as string | undefined) ||
    process.env.NAMECHEAP_CLIENT_IP ||
    "127.0.0.1"
  ).trim();

  const baseUrl =
    (config?.baseUrl as string | undefined)?.trim() || "https://api.namecheap.com/xml.response";

  const balancesUrl = new URL(baseUrl);
  balancesUrl.searchParams.set("ApiUser", apiUser);
  balancesUrl.searchParams.set("ApiKey", trimmedKey);
  balancesUrl.searchParams.set("UserName", apiUser);
  balancesUrl.searchParams.set("ClientIP", clientIp);
  balancesUrl.searchParams.set("Command", "namecheap.users.getBalances");

  const domainsUrl = new URL(baseUrl);
  domainsUrl.searchParams.set("ApiUser", apiUser);
  domainsUrl.searchParams.set("ApiKey", trimmedKey);
  domainsUrl.searchParams.set("UserName", apiUser);
  domainsUrl.searchParams.set("ClientIP", clientIp);
  domainsUrl.searchParams.set("Command", "namecheap.domains.getList");
  domainsUrl.searchParams.set("PageSize", "100");

  const [balancesRes, domainsRes] = await Promise.all([
    fetchJson(balancesUrl.toString()),
    fetchJson(domainsUrl.toString()),
  ]);

  if (!balancesRes.ok && !domainsRes.ok) {
    return errorResult(balancesRes.status || domainsRes.status, {
      note: "Namecheap API requests failed",
    });
  }

  const balancesRawText = typeof balancesRes.data === "string" ? balancesRes.data : "";
  const domainsRawText = typeof domainsRes.data === "string" ? domainsRes.data : "";

  // Check for API-level errors
  const balancesErrors = extractNamecheapErrors(balancesRawText);
  if (balancesErrors.length > 0 && !domainsRes.ok) {
    throw new AdapterError(`Namecheap API error: ${balancesErrors.join("; ")}`, {
      code: "HTTP_ERROR",
      status: balancesRes.status || 400,
    });
  }

  const balances = parseBalancesXml(balancesRawText);
  const { domains, totalItems } = parseDomainsXml(domainsRawText);

  const availableBalance = balances?.availableBalance ?? balances?.accountBalance ?? null;

  return {
    balance: availableBalance,
    totalCost: null,
    totalRequests: totalItems,
    credits: availableBalance,
    rawData: {
      balances,
      domains,
      totalDomains: totalItems,
      apiUser,
    },
  };
}
