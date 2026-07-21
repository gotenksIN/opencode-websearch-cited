import { Plugin } from "@opencode-ai/plugin/v2";

import { createGoogleWebsearchClient, type GoogleWebsearchConfig } from "./src/google.ts";
import { createOpenAIWebsearchClient, type OpenAIWebsearchConfig } from "./src/openai.ts";
import { createOpenRouterWebsearchClient } from "./src/openrouter.ts";
import type { GetAuth } from "./src/types.ts";

const GOOGLE_PROVIDER_ID = "google";
const OPENAI_PROVIDER_ID = "openai";
const OPENROUTER_PROVIDER_ID = "openrouter";

const CITED_SEARCH_TOOL_DESCRIPTION =
	"Performs a Gemini-style grounded web search: returns a concise digest with inline citations and a Sources list of URLs. NOTE: for LLM rate limits, DO NOT parallel this tool > 5";

const WEBSEARCH_ALLOWED_KEYS = new Set(["query"]);
const WEBSEARCH_TIMEOUT_MS = 120_000;

type SelectedProviderID = typeof GOOGLE_PROVIDER_ID | typeof OPENAI_PROVIDER_ID | typeof OPENROUTER_PROVIDER_ID;

type SelectedWebsearchConfig = {
	providerID: SelectedProviderID;
	model: string;
};

type WebsearchCitedSelection = {
	selected?: SelectedWebsearchConfig;
	error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function selectWebsearchConfig(options: unknown): WebsearchCitedSelection {
	if (!isRecord(options)) {
		return {};
	}

	const providerID = options.provider;
	const model = options.model;
	if (providerID === undefined && model === undefined) {
		return {};
	}
	if (typeof providerID !== "string" || providerID.trim() === "") {
		return { error: "Missing websearch_cited provider configuration." };
	}
	if (providerID !== GOOGLE_PROVIDER_ID && providerID !== OPENAI_PROVIDER_ID && providerID !== OPENROUTER_PROVIDER_ID) {
		return { error: `Unsupported provider "${providerID}" for websearch_cited.` };
	}
	if (typeof model !== "string" || model.trim() === "") {
		return { error: `Missing websearch_cited model for provider "${providerID}".` };
	}

	return {
		selected: {
			providerID,
			model: model.trim(),
		},
	};
}

function parseOpenAIOptions(settings: unknown): OpenAIWebsearchConfig {
	if (!isRecord(settings)) {
		return {};
	}

	const result: OpenAIWebsearchConfig = {};
	const reasoningEffort = settings.reasoningEffort;
	if (typeof reasoningEffort === "string" && reasoningEffort.trim() !== "") {
		result.reasoningEffort = reasoningEffort.trim();
	}

	const reasoningSummary = settings.reasoningSummary;
	if (typeof reasoningSummary === "string" && reasoningSummary.trim() !== "") {
		result.reasoningSummary = reasoningSummary.trim();
	}

	const textVerbosity = settings.textVerbosity;
	if (typeof textVerbosity === "string" && textVerbosity.trim() !== "") {
		result.textVerbosity = textVerbosity.trim();
	}

	const store = settings.store;
	if (typeof store === "boolean") {
		result.store = store;
	}

	const include = settings.include;
	if (Array.isArray(include)) {
		const filtered = include.filter((value): value is string => typeof value === "string" && value.trim() !== "");
		if (filtered.length > 0) {
			result.include = filtered;
		}
	}

	return result;
}

function parseGoogleOptions(settings: unknown): GoogleWebsearchConfig {
	if (!isRecord(settings)) {
		return {};
	}

	const result: GoogleWebsearchConfig = {};
	const baseURL = settings.baseURL;
	if (typeof baseURL === "string" && baseURL.trim() !== "") {
		result.baseURL = baseURL.trim();
	}

	return result;
}

const WebsearchCitedPlugin = Plugin.define({
	id: "opencode.websearch-cited",
	setup: async (ctx) => {
		const { selected, error: configError } = selectWebsearchConfig(ctx.options);
		let openaiConfig: OpenAIWebsearchConfig = {};
		let googleConfig: GoogleWebsearchConfig = {};
		let integrationID: string | undefined = selected?.providerID;
		let selectedSettings: Record<string, unknown> = {};

		if (selected) {
			await ctx.catalog.transform((catalog) => {
				const record = catalog.provider.get(selected.providerID);
				integrationID = record?.provider.integrationID ?? selected.providerID;
				selectedSettings = {
					...record?.provider.settings,
					...record?.models.get(selected.model)?.settings,
				};
				openaiConfig = selected.providerID === OPENAI_PROVIDER_ID ? parseOpenAIOptions(selectedSettings) : {};
				googleConfig = selected.providerID === GOOGLE_PROVIDER_ID ? parseGoogleOptions(selectedSettings) : {};
			});
		}

		const getAuth =
			(providerID: SelectedProviderID): GetAuth =>
			async () => {
				const connection = await ctx.integration.connection.active(integrationID ?? providerID);
				if (connection) {
					const credential = await ctx.integration.connection.resolve(connection);
					if (credential) {
						return credential;
					}
				}
				const apiKey = selectedSettings.apiKey;
				return typeof apiKey === "string" && apiKey.trim() !== "" ? { type: "key", key: apiKey } : undefined;
			};

		await ctx.tool.transform((tools) => {
			tools.add({
				name: "websearch_cited",
				options: { codemode: false },
				description: CITED_SEARCH_TOOL_DESCRIPTION,
				jsonSchema: {
					type: "object",
					properties: {
						query: {
							type: "string",
							description: "The natural language web search query.",
						},
					},
					required: ["query"],
					additionalProperties: false,
				},
				async execute(input) {
					const args = isRecord(input) ? input : {};
					const extraKeys = Object.keys(args).filter((key) => !WEBSEARCH_ALLOWED_KEYS.has(key));
					if (extraKeys.length > 0) {
						throw new Error(`Unknown argument(s): ${extraKeys.join(", ")}, only 'query' supported.`);
					}

					const query = typeof args.query === "string" ? args.query.trim() : "";
					if (!query) {
						throw new Error("The 'query' parameter cannot be empty.");
					}

					if (configError) {
						throw new Error(configError);
					}
					if (!selected) {
						throw new Error("Missing web search model configuration.");
					}

					const abortSignal = AbortSignal.timeout(WEBSEARCH_TIMEOUT_MS);
					let text: string;
					if (selected.providerID === OPENAI_PROVIDER_ID) {
						const client = createOpenAIWebsearchClient(selected.model, openaiConfig);
						text = await client.search(query, abortSignal, getAuth(selected.providerID));
					} else if (selected.providerID === OPENROUTER_PROVIDER_ID) {
						const client = createOpenRouterWebsearchClient(selected.model);
						text = await client.search(query, abortSignal, getAuth(selected.providerID));
					} else {
						const client = createGoogleWebsearchClient(selected.model, googleConfig);
						text = await client.search(query, abortSignal, getAuth(selected.providerID));
					}

					return {
						structured: { text },
						content: [{ type: "text", text }],
					};
				},
			});
		});
	},
});

export default WebsearchCitedPlugin;
