import type { CredentialValue } from "@opencode-ai/sdk/v2/types";

export type ProviderAuth = CredentialValue;

export type GetAuth = () => Promise<ProviderAuth | undefined>;

export interface WebsearchClient {
	search(query: string, abortSignal: AbortSignal, getAuth: GetAuth): Promise<string>;
}
