import { decrypt } from "@/lib/crypto";
import { canonicalProviderKey } from "@/lib/provider-identity";
import {
  decryptProviderSecretConfig,
  mergeProviderConfig,
  splitProviderConfig,
} from "@/lib/provider-secret-config";

export function isAnthropicAdminApiKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().toLowerCase().startsWith("sk-ant-admin")
  );
}

interface StoredProviderCredentials {
  name: string;
  apiKey?: string | null;
  config?: unknown;
  secretConfig?: string | null;
}

/**
 * Derive Anthropic billing capability without returning credential material.
 * `apiKey` is the encrypted Provider column; config may contain a legacy
 * plaintext admin field while secretConfig is the current encrypted store.
 */
export function hasStoredAnthropicAdminApiKey(
  provider: StoredProviderCredentials
): boolean {
  if (canonicalProviderKey(provider.name) !== "anthropic") return false;

  const legacyConfig = splitProviderConfig(provider.config);
  let encryptedConfig: Record<string, unknown> = {};
  try {
    encryptedConfig = decryptProviderSecretConfig(provider.secretConfig);
  } catch {
    // An unreadable credential cannot be claimed as configured capability.
  }
  const secretConfig = mergeProviderConfig(
    legacyConfig.secretConfig,
    encryptedConfig
  );
  if (isAnthropicAdminApiKey(secretConfig.adminApiKey)) {
    return true;
  }

  if (!provider.apiKey) return false;
  try {
    return isAnthropicAdminApiKey(decrypt(provider.apiKey));
  } catch {
    return false;
  }
}

export function providerPollSnapshotExpected(
  provider: StoredProviderCredentials
): boolean {
  return canonicalProviderKey(provider.name) !== "anthropic"
    ? true
    : hasStoredAnthropicAdminApiKey(provider);
}
