import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Plugin } from "@opencode-ai/plugin/v2";

import { formatWebSearchResponse } from "./src/google.ts";
import type { ProviderAuth } from "./src/types.ts";

type ProviderConfig = {
	options?: Record<string, unknown>;
	models?: Record<string, { modelID?: string; options?: Record<string, unknown> }>;
};

type Config = {
	provider?: Record<string, ProviderConfig>;
};

type TestAuth =
	| { type: "key"; key: string }
	| { type: "oauth"; methodID?: string; access: string; refresh: string; expires?: number };

const WEBSEARCH_CONFIG: Config = {
	provider: {
		google: {
			options: {
				websearch_cited: {
					model: "gemini-2.5-flash",
				},
			},
		},
	},
};

let importCounter = 0;

type WebSearchGenerateContentResponse = Parameters<typeof formatWebSearchResponse>[0];

describe("formatWebSearchResponse", () => {
	it("returns fallback when response has no text", () => {
		const response = createResponse({
			content: {
				role: "model",
				parts: [{ text: "" }],
			},
		});

		const result = formatWebSearchResponse(response, "no results query");

		expect(result).toBe('No search results or information found for query: "no results query"');
	});

	it("formats results without sources", () => {
		const response = createResponse({
			content: {
				role: "model",
				parts: [{ text: "Here are your results." }],
			},
		});

		const result = formatWebSearchResponse(response, "successful query");

		expect(result).toBe("Here are your results.");
	});

	it("inserts citations and sources for grounding metadata", () => {
		const response = createResponse({
			content: {
				role: "model",
				parts: [{ text: "This is a test response." }],
			},
			groundingMetadata: {
				groundingChunks: [
					{ web: { uri: "https://example.com", title: "Example Site" } },
					{ web: { uri: "https://google.com", title: "Google" } },
				],
				groundingSupports: [
					{
						segment: { startIndex: 5, endIndex: 14 },
						groundingChunkIndices: [0],
					},
					{
						segment: { startIndex: 15, endIndex: 24 },
						groundingChunkIndices: [0, 1],
					},
				],
			},
		});

		const result = formatWebSearchResponse(response, "grounding query");

		expect(result).toBe(
			"This is a test[1] response.[1][2]\n\nSources:\n[1] Example Site (https://example.com)\n[2] Google (https://google.com)"
		);
	});

	it("respects UTF-8 byte indices for citation insertion", () => {
		const response = createResponse({
			content: {
				role: "model",
				parts: [{ text: "こんにちは! Web Search✨️" }],
			},
			groundingMetadata: {
				groundingChunks: [
					{
						web: {
							title: "Japanese Greeting",
							uri: "https://example.test/japanese-greeting",
						},
					},
					{
						web: {
							title: "Example Repo",
							uri: "https://example.test/repo",
						},
					},
					{
						web: {
							title: "Example Article",
							uri: "https://example.test/article",
						},
					},
				],
				groundingSupports: [
					{
						segment: { startIndex: 0, endIndex: 16 },
						groundingChunkIndices: [0],
					},
					{
						segment: { startIndex: 17, endIndex: 33 },
						groundingChunkIndices: [1, 2],
					},
				],
			},
		});

		const result = formatWebSearchResponse(response, "multibyte query");

		expect(result).toBe(
			"こんにちは![1] Web Search✨️[2][3]\n\nSources:\n[1] Japanese Greeting (https://example.test/japanese-greeting)\n[2] Example Repo (https://example.test/repo)\n[3] Example Article (https://example.test/article)"
		);
	});

	it("uses partIndex when inserting citations into multi-part responses", () => {
		const response = createResponse({
			content: {
				role: "model",
				parts: [{ text: "Alpha. " }, { text: "Beta." }],
			},
			groundingMetadata: {
				groundingChunks: [{ web: { title: "Beta Source", uri: "https://example.test/beta" } }],
				groundingSupports: [
					{
						segment: { partIndex: 1, startIndex: 0, endIndex: 5 },
						groundingChunkIndices: [0],
					},
				],
			},
		});

		const result = formatWebSearchResponse(response, "multipart query");

		expect(result).toBe("Alpha. Beta.[1]\n\nSources:\n[1] Beta Source (https://example.test/beta)");
	});

	it("ignores citation indices without matching sources", () => {
		const response = createResponse({
			content: {
				role: "model",
				parts: [{ text: "Fact." }],
			},
			groundingMetadata: {
				groundingChunks: [{ web: { title: "Used", uri: "https://example.test/used" } }],
				groundingSupports: [
					{
						segment: { endIndex: 5 },
						groundingChunkIndices: [0, 2],
					},
				],
			},
		});

		const result = formatWebSearchResponse(response, "invalid citation query");

		expect(result).toBe("Fact.[1]\n\nSources:\n[1] Used (https://example.test/used)");
	});

	it("coalesces citations inserted at the same byte index", () => {
		const response = createResponse({
			content: {
				role: "model",
				parts: [{ text: "Fact." }],
			},
			groundingMetadata: {
				groundingChunks: [
					{ web: { title: "First", uri: "https://example.test/first" } },
					{ web: { title: "Second", uri: "https://example.test/second" } },
				],
				groundingSupports: [
					{ segment: { endIndex: 5 }, groundingChunkIndices: [0] },
					{ segment: { endIndex: 5 }, groundingChunkIndices: [1] },
				],
			},
		});

		const result = formatWebSearchResponse(response, "same index query");

		expect(result).toBe(
			"Fact.[1][2]\n\nSources:\n[1] First (https://example.test/first)\n[2] Second (https://example.test/second)"
		);
	});

	it("does not corrupt text when citation byte indices are invalid", () => {
		const response = createResponse({
			content: {
				role: "model",
				parts: [{ text: "éclair" }],
			},
			groundingMetadata: {
				groundingChunks: [{ web: { title: "Accent", uri: "https://example.test/accent" } }],
				groundingSupports: [{ segment: { endIndex: 1 }, groundingChunkIndices: [0] }],
			},
		});

		const result = formatWebSearchResponse(response, "invalid byte query");

		expect(result).toBe("éclair\n\nSources:\n[1] Accent (https://example.test/accent)");
	});

	it("omits unreferenced and invalid sources", () => {
		const response = createResponse({
			content: {
				role: "model",
				parts: [{ text: "Fact." }],
			},
			groundingMetadata: {
				groundingChunks: [
					{ web: { title: "Used", uri: "https://example.test/used" } },
					{ web: { title: "Unused", uri: "https://example.test/unused" } },
					{ web: { title: "Missing URI" } },
				],
				groundingSupports: [{ segment: { endIndex: 5 }, groundingChunkIndices: [0, 2] }],
			},
		});

		const result = formatWebSearchResponse(response, "source filter query");

		expect(result).toBe("Fact.[1]\n\nSources:\n[1] Used (https://example.test/used)");
	});
});

describe("WebsearchCitedPlugin", () => {
	let fetchMock: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

	beforeEach(() => {
		fetchMock = vi.spyOn(globalThis, "fetch");
		fetchMock.mockRejectedValue(new Error("fetch mock not configured"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns configuration error when API key is missing", async () => {
		const { tool } = await createEnv(WEBSEARCH_CONFIG);

		const context = createToolContext();

		await expectThrowMessage(() => tool.execute({ query: "opencode" }, context), 'Missing auth for provider "google"');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("accepts V2 plugin options", async () => {
		const { tool } = await createEnv(undefined, { provider: "google", model: "gemini-2.5-flash" });

		await expectThrowMessage(
			() => tool.execute({ query: "opencode" }, createToolContext()),
			'Missing auth for provider "google"'
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns invalid model when websearch model is not configured", async () => {
		const { tool } = await createEnv();
		const context = createToolContext();

		await expectThrowMessage(
			() => tool.execute({ query: "opencode" }, context),
			"Missing web search model configuration"
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns invalid model when configured model is blank", async () => {
		const { tool } = await createEnv({
			provider: {
				google: {
					options: {
						websearch_cited: { model: "" },
					},
				},
			},
		} as Config);
		const context = createToolContext();

		await expectThrowMessage(
			() => tool.execute({ query: "opencode" }, context),
			'Missing websearch_cited model for provider "google"'
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not fail init when config has no websearch model", async () => {
		const { tool } = await createEnv({
			provider: {
				google: {},
			},
		} as Config);
		const context = createToolContext();

		await expectThrowMessage(
			() => tool.execute({ query: "opencode" }, context),
			"Missing web search model configuration"
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips invalid provider configs and uses the first valid one", async () => {
		const { tool } = await createEnv({
			provider: {
				openai: {
					options: {
						websearch_cited: { model: "" },
					},
				},
				google: {
					options: {
						websearch_cited: { model: "gemini-2.5-flash" },
					},
				},
			},
		} as Config);
		const context = createToolContext();

		await expectThrowMessage(() => tool.execute({ query: "opencode" }, context), 'Missing auth for provider "google"');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects extra arguments", async () => {
		const { tool } = await createEnv();
		const context = createToolContext();

		await expectThrowMessage(
			() => tool.execute({ query: "sample", format: "markdown" } as never, context),
			"Unknown argument(s): format, only 'query' supported"
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns successful search results", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse(
				createResponse({
					content: {
						role: "model",
						parts: [{ text: "Search body" }],
					},
					groundingMetadata: {
						groundingChunks: [{ web: { title: "Example", uri: "https://example.com" } }],
						groundingSupports: [
							{
								segment: { startIndex: 0, endIndex: 6 },
								groundingChunkIndices: [0],
							},
						],
					},
				})
			)
		);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", { type: "key", key: "stored-key" });
		const context = createToolContext();

		const result = await tool.execute({ query: "sample" }, context);

		expect(result).toContain("Search");
		expect(result).toContain("Sources:\n[1] Example (https://example.com)");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns provider failure details", async () => {
		const failure = new Error("API Failure");
		fetchMock.mockRejectedValueOnce(failure);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", { type: "key", key: "stored-key" });
		const context = createToolContext();

		try {
			await tool.execute({ query: "sample" }, context);
			throw new Error("Expected execute to throw");
		} catch (error) {
			expect(error).toBe(failure);
		}
	});

	it("uses the API key from provider auth", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse(
				createResponse({
					content: {
						role: "model",
						parts: [{ text: "Stored key response" }],
					},
				})
			)
		);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", { type: "key", key: "stored-key" });
		const context = createToolContext();

		await tool.execute({ query: "stored key query" }, context);

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init?.headers ?? {}) as Record<string, string>;
		expect(headers["x-goog-api-key"]).toBe("stored-key");
	});

	it("falls back to the provider apiKey setting", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse(
				createResponse({
					content: {
						role: "model",
						parts: [{ text: "Configured key response" }],
					},
				})
			)
		);

		const { tool } = await createEnv({
			provider: {
				google: {
					options: {
						apiKey: "configured-key",
						websearch_cited: { model: "gemini-2.5-flash" },
					},
				},
			},
		});

		await tool.execute({ query: "configured key query" }, createToolContext());

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init?.headers ?? {}) as Record<string, string>;
		expect(headers["x-goog-api-key"]).toBe("configured-key");
	});

	it("throws Google API error envelopes from successful responses", async () => {
		fetchMock.mockResolvedValueOnce(createFetchResponse({ error: { message: "quota exceeded" } }));

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", { type: "key", key: "stored-key" });

		await expectThrowMessage(() => tool.execute({ query: "stored key query" }, createToolContext()), "quota exceeded");
	});

	it("uses the configured model", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse(
				createResponse({
					content: {
						role: "model",
						parts: [{ text: "Default model response" }],
					},
				})
			)
		);

		const { hooks, tool } = await createEnv({
			provider: {
				google: {
					options: {
						websearch_cited: { model: "gemini-custom-model" },
					},
				},
			},
		} as Config);
		await setCredential(hooks, "google", { type: "key", key: "stored-key" });
		const context = createToolContext();

		await tool.execute({ query: "model query" }, context);

		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(typeof url === "string" ? url : "").toContain("gemini-custom-model");
	});

	it("uses the upstream modelID for a catalog alias", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse(
				createResponse({
					content: {
						role: "model",
						parts: [{ text: "Aliased model response" }],
					},
				})
			)
		);

		const { hooks, tool } = await createEnv({
			provider: {
				google: {
					options: {
						websearch_cited: { model: "search" },
					},
					models: {
						search: { modelID: "gemini-upstream-model" },
					},
				},
			},
		});
		await setCredential(hooks, "google", { type: "key", key: "stored-key" });

		await tool.execute({ query: "model query" }, createToolContext());

		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(typeof url === "string" ? url : "").toContain("gemini-upstream-model");
	});

	it("normalizes a trailing slash in the configured Google baseURL", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse(
				createResponse({
					content: {
						role: "model",
						parts: [{ text: "Trailing slash response" }],
					},
				})
			)
		);

		const { hooks, tool } = await createEnv({
			provider: {
				google: {
					options: {
						baseURL: "https://proxy.example.test/v1beta/",
						websearch_cited: { model: "gemini-custom-model" },
					},
				},
			},
		} as Config);
		await setCredential(hooks, "google", { type: "key", key: "stored-key" });
		const context = createToolContext();

		await tool.execute({ query: "model query" }, context);

		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://proxy.example.test/v1beta/models/gemini-custom-model:generateContent");
	});

	it("ignores non-string Google baseURL values", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse(
				createResponse({
					content: {
						role: "model",
						parts: [{ text: "Default base URL response" }],
					},
				})
			)
		);

		const { hooks, tool } = await createEnv({
			provider: {
				google: {
					options: {
						baseURL: true,
						websearch_cited: { model: "gemini-custom-model" },
					},
				},
			},
		} as unknown as Config);
		await setCredential(hooks, "google", { type: "key", key: "stored-key" });
		const context = createToolContext();

		await tool.execute({ query: "model query" }, context);

		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-custom-model:generateContent");
	});

	it("rejects unsupported Google OAuth methods", async () => {
		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			methodID: "other-google-oauth",
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 120_000,
		});

		await expectThrowMessage(
			() => tool.execute({ query: "oauth query" }, createToolContext()),
			'Unsupported Google OAuth method "other-google-oauth"'
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses Code Assist endpoint and project when Google OAuth is present", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse({
				response: createResponse({
					content: {
						role: "model",
						parts: [{ text: "OAuth response" }],
					},
				}),
			})
		);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "test-access-token",
			refresh: "test-refresh|user-project|managed-project",
			expires: Date.now() + 120_000,
		});
		const context = createToolContext();

		const result = await tool.execute({ query: "oauth query" }, context);

		expect(result).toContain("OAuth response");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(typeof url === "string" ? url : "").toContain(
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent"
		);

		const headers = (init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-access-token");

		const bodyText = typeof init?.body === "string" ? init.body : "";
		const parsed = JSON.parse(bodyText) as Record<string, unknown>;
		expect(parsed.project).toBe("managed-project");
		expect(parsed.model).toBe("gemini-2.5-flash");

		const request = parsed.request;
		expect(request && typeof request === "object").toBe(true);
	});

	it("prefers managedProjectId over projectId for Google OAuth", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse({
				response: createResponse({
					content: {
						role: "model",
						parts: [{ text: "OAuth project preference" }],
					},
				}),
			})
		);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "test-access-token",
			refresh: "refresh-token-project|user-project|managed-project",
			expires: Date.now() + 120_000,
		});
		const context = createToolContext();

		await tool.execute({ query: "oauth query" }, context);

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const bodyText = typeof init?.body === "string" ? init.body : "";
		const parsed = JSON.parse(bodyText) as Record<string, unknown>;
		expect(parsed.project).toBe("managed-project");
	});

	it("uses managedProjectId when projectId is empty for Google OAuth", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse({
				response: createResponse({
					content: {
						role: "model",
						parts: [{ text: "OAuth managed project fallback" }],
					},
				}),
			})
		);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "test-access-token",
			refresh: "refresh-token-managed||managed-project",
			expires: Date.now() + 120_000,
		});
		const context = createToolContext();

		await tool.execute({ query: "oauth query" }, context);

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const bodyText = typeof init?.body === "string" ? init.body : "";
		const parsed = JSON.parse(bodyText) as Record<string, unknown>;
		expect(parsed.project).toBe("managed-project");
	});

	it("falls back to loadCodeAssist when project metadata is missing", async () => {
		fetchMock
			.mockResolvedValueOnce(createFetchResponse({ cloudaicompanionProject: "load-project" }))
			.mockResolvedValueOnce(
				createFetchResponse({
					response: createResponse({
						content: {
							role: "model",
							parts: [{ text: "Fallback project response" }],
						},
					}),
				})
			);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "test-access-token",
			refresh: "refresh-token-load",
			expires: Date.now() + 120_000,
		});

		const context = createToolContext();

		const result = await tool.execute({ query: "oauth query" }, context);

		expect(result).toContain("Fallback project response");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [loadUrl, loadInit] = fetchMock.mock.calls[0] ?? [];
		expect(typeof loadUrl === "string" ? loadUrl : "").toContain(
			"https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
		);
		const loadHeaders = (loadInit?.headers ?? {}) as Record<string, string>;
		expect(loadHeaders.Authorization).toBe("Bearer test-access-token");

		const [url, init] = fetchMock.mock.calls[1] ?? [];
		expect(typeof url === "string" ? url : "").toContain(
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent"
		);
		const bodyText = typeof init?.body === "string" ? init.body : "";
		const parsed = JSON.parse(bodyText) as Record<string, unknown>;
		expect(parsed.project).toBe("load-project");
	});

	it("tries the next Code Assist generate endpoint after auth failure", async () => {
		fetchMock
			.mockResolvedValueOnce(createFetchResponse({ error: "daily forbidden" }, { ok: false, status: 403 }))
			.mockResolvedValueOnce(
				createFetchResponse({
					response: createResponse({
						content: { role: "model", parts: [{ text: "Fallback endpoint response" }] },
					}),
				})
			);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "test-access-token",
			refresh: "refresh-token-generate-fallback|project-id|managed-project",
			expires: Date.now() + 120_000,
		});

		const result = await tool.execute({ query: "oauth query" }, createToolContext());

		expect(result).toContain("Fallback endpoint response");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [firstUrl] = fetchMock.mock.calls[0] ?? [];
		const [secondUrl] = fetchMock.mock.calls[1] ?? [];
		expect(typeof firstUrl === "string" ? firstUrl : "").toContain("daily-cloudcode-pa");
		expect(typeof secondUrl === "string" ? secondUrl : "").toContain("autopush-cloudcode-pa");
	});

	it("tries the next Code Assist generate endpoint after fetch failure", async () => {
		fetchMock.mockRejectedValueOnce(new Error("daily unavailable")).mockResolvedValueOnce(
			createFetchResponse({
				response: createResponse({
					content: { role: "model", parts: [{ text: "Network fallback response" }] },
				}),
			})
		);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "test-access-token",
			refresh: "refresh-token-network-fallback|project-id|managed-project",
			expires: Date.now() + 120_000,
		});

		const result = await tool.execute({ query: "oauth query" }, createToolContext());

		expect(result).toContain("Network fallback response");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("parses Code Assist array responses beyond the first item", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse([
				{ metadata: {} },
				{
					response: createResponse({
						content: { role: "model", parts: [{ text: "Array response" }] },
					}),
				},
			])
		);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "test-access-token",
			refresh: "refresh-token-array|project-id|managed-project",
			expires: Date.now() + 120_000,
		});

		const result = await tool.execute({ query: "oauth query" }, createToolContext());

		expect(result).toContain("Array response");
	});

	it("keys loaded Google projects by refresh token and project", async () => {
		fetchMock
			.mockResolvedValueOnce(createFetchResponse({ cloudaicompanionProject: "managed-a" }))
			.mockResolvedValueOnce(
				createFetchResponse({
					response: createResponse({
						content: { role: "model", parts: [{ text: "Project A" }] },
					}),
				})
			)
			.mockResolvedValueOnce(createFetchResponse({ cloudaicompanionProject: "managed-b" }))
			.mockResolvedValueOnce(
				createFetchResponse({
					response: createResponse({
						content: { role: "model", parts: [{ text: "Project B" }] },
					}),
				})
			);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "test-access-token",
			refresh: "shared-refresh-token|project-a|",
			expires: Date.now() + 120_000,
		});
		const first = await tool.execute({ query: "oauth query" }, createToolContext());

		await setCredential(hooks, "google", {
			type: "oauth",
			access: "test-access-token",
			refresh: "shared-refresh-token|project-b|",
			expires: Date.now() + 120_000,
		});
		const second = await tool.execute({ query: "oauth query" }, createToolContext());

		expect(first).toContain("Project A");
		expect(second).toContain("Project B");
		expect(fetchMock).toHaveBeenCalledTimes(4);
		const firstGenerateBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
		const secondGenerateBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as Record<string, unknown>;
		expect(firstGenerateBody.project).toBe("managed-a");
		expect(secondGenerateBody.project).toBe("managed-b");
	});

	it("refreshes expired OAuth access token and uses it", async () => {
		fetchMock
			.mockResolvedValueOnce(createFetchResponse({ access_token: "new-access", expires_in: 3600 }))
			.mockResolvedValueOnce(createFetchResponse({}))
			.mockResolvedValueOnce(
				createFetchResponse({
					response: createResponse({
						content: { role: "model", parts: [{ text: "Refreshed response" }] },
					}),
				})
			);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "stale-access",
			refresh: "refresh-token-expired|project-id|",
			expires: Date.now() - 1,
		});

		const context = createToolContext();

		const result = await tool.execute({ query: "oauth query" }, context);

		expect(result).toContain("Refreshed response");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] ?? [];
		expect(typeof tokenUrl === "string" ? tokenUrl : "").toContain("https://oauth2.googleapis.com/token");
		const tokenBodyValue = tokenInit?.body;
		const tokenBody =
			tokenBodyValue instanceof URLSearchParams ? tokenBodyValue : new URLSearchParams(tokenBodyValue as string);
		expect(tokenBody.get("refresh_token")).toBe("refresh-token-expired");

		const [loadUrl] = fetchMock.mock.calls[1] ?? [];
		expect(typeof loadUrl === "string" ? loadUrl : "").toContain(
			"https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
		);

		const [, generateInit] = fetchMock.mock.calls[2] ?? [];
		const headers = (generateInit?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer new-access");
	});

	it("refreshes when expires is missing", async () => {
		fetchMock
			.mockResolvedValueOnce(createFetchResponse({ access_token: "new-access", expires_in: 3600 }))
			.mockResolvedValueOnce(createFetchResponse({}))
			.mockResolvedValueOnce(
				createFetchResponse({
					response: createResponse({
						content: { role: "model", parts: [{ text: "Refreshed response" }] },
					}),
				})
			);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "stale-access",
			refresh: "refresh-token-retry|project-id|",
		} as TestAuth);

		const context = createToolContext();

		const result = await tool.execute({ query: "oauth query" }, context);

		expect(result).toContain("Refreshed response");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const tokenCall = fetchMock.mock.calls[0];
		const tokenUrl = tokenCall?.[0];
		expect(typeof tokenUrl === "string" ? tokenUrl : "").toContain("https://oauth2.googleapis.com/token");
		const [loadUrl] = fetchMock.mock.calls[1] ?? [];
		expect(typeof loadUrl === "string" ? loadUrl : "").toContain(
			"https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
		);
		const retryHeaders = (fetchMock.mock.calls[2]?.[1]?.headers ?? {}) as Record<string, string>;
		expect(retryHeaders.Authorization).toBe("Bearer new-access");
	});

	it("throws when refresh fails", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse(
				{ error: { message: "invalid_client" } },
				{ ok: false, status: 400, statusText: "Bad Request" }
			)
		);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "",
			refresh: "refresh-token-fail|project-id|",
			expires: Date.now() + 120_000,
		});

		const context = createToolContext();

		await expectThrowMessage(() => tool.execute({ query: "oauth query" }, context), "invalid_client");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [callUrl] = fetchMock.mock.calls[0] ?? [];
		expect(typeof callUrl === "string" ? callUrl : "").toContain("https://oauth2.googleapis.com/token");
	});

	it("reuses cached refreshed token within same module instance", async () => {
		fetchMock
			.mockResolvedValueOnce(createFetchResponse({ access_token: "cached-access", expires_in: 3600 }))
			.mockResolvedValueOnce(createFetchResponse({ cloudaicompanionProject: "managed-project" }))
			.mockResolvedValueOnce(
				createFetchResponse({
					response: createResponse({
						content: { role: "model", parts: [{ text: "First call" }] },
					}),
				})
			)
			.mockResolvedValueOnce(
				createFetchResponse({
					response: createResponse({
						content: { role: "model", parts: [{ text: "Second call" }] },
					}),
				})
			);

		const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
		await setCredential(hooks, "google", {
			type: "oauth",
			access: "expired-access",
			refresh: "refresh-token-cache|project-id|",
			expires: Date.now() - 1,
		});

		const context = createToolContext();

		const first = await tool.execute({ query: "oauth query" }, context);
		const second = await tool.execute({ query: "oauth query" }, context);

		expect(first).toContain("First call");
		expect(second).toContain("Second call");
		expect(fetchMock).toHaveBeenCalledTimes(4);
		const generateHeaders = (fetchMock.mock.calls[2]?.[1]?.headers ?? {}) as Record<string, string>;
		const secondHeaders = (fetchMock.mock.calls[3]?.[1]?.headers ?? {}) as Record<string, string>;
		expect(generateHeaders.Authorization).toBe("Bearer cached-access");
		expect(secondHeaders.Authorization).toBe("Bearer cached-access");
	});

	it("returns invalid auth when OpenAI websearch is configured but auth is missing", async () => {
		const { tool } = await createEnv({
			provider: {
				openai: {
					options: {
						websearch_cited: { model: "gpt-4o-search-preview" },
					},
				},
			},
		} as Config);
		const context = createToolContext();

		await expectThrowMessage(() => tool.execute({ query: "openai" }, context), 'Missing auth for provider "openai"');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns invalid auth when OpenRouter websearch is configured but auth is missing", async () => {
		const { tool } = await createEnv({
			provider: {
				openrouter: {
					options: {
						websearch_cited: { model: "openrouter/auto" },
					},
				},
			},
		} as Config);
		const context = createToolContext();

		await expectThrowMessage(
			() => tool.execute({ query: "openrouter" }, context),
			'Missing auth for provider "openrouter"'
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses the OpenAI responses endpoint when configured and auth is present", async () => {
		fetchMock.mockResolvedValueOnce(createFetchResponse(createOpenAIResponseBody("Search result body")));

		const { hooks, tool } = await createEnv({
			provider: {
				openai: {
					options: {
						websearch_cited: { model: "gpt-4o-search-preview" },
					},
				},
			},
		} as Config);

		await setCredential(hooks, "openai", {
			type: "oauth",
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 60_000,
		});

		const context = createToolContext();

		const result = await tool.execute({ query: "openai web search" }, context);

		expect(result).toContain("Search result body");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(typeof url === "string" ? url : "").toContain("/codex/responses");
		const headers = (init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-access-token");
	});

	it("uses the OpenAI API endpoint when API key auth is present", async () => {
		fetchMock.mockResolvedValueOnce(createFetchResponse(createOpenAIResponseBody("Search result body")));

		const { hooks, tool } = await createEnv({
			provider: {
				openai: {
					options: {
						websearch_cited: { model: "gpt-4o-search-preview" },
					},
				},
			},
		} as Config);

		await setCredential(hooks, "openai", {
			type: "key",
			key: "test-api-key",
		});

		const context = createToolContext();

		const result = await tool.execute({ query: "openai web search" }, context);

		expect(result).toContain("Search result body");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(typeof url === "string" ? url : "").toContain("https://api.openai.com/v1/responses");
		const headers = (init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-api-key");
	});

	it("passes configured OpenAI store option", async () => {
		fetchMock.mockResolvedValueOnce(createFetchResponse(createOpenAIResponseBody("Stored response")));

		const { hooks, tool } = await createEnv({
			provider: {
				openai: {
					options: {
						store: true,
						websearch_cited: { model: "gpt-4o-search-preview" },
					},
				},
			},
		} as Config);

		await setCredential(hooks, "openai", {
			type: "key",
			key: "test-api-key",
		});

		await tool.execute({ query: "openai web search" }, createToolContext());

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(body.store).toBe(true);
	});

	it("adds OpenAI sources from response metadata", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse({
				output: [
					{
						type: "web_search_call",
						action: {
							sources: [{ title: "Search Source", url: "https://example.test/search" }],
						},
					},
					{
						role: "assistant",
						content: [
							{
								type: "output_text",
								text: "OpenAI answer",
								annotations: [{ title: "Annotation Source", url: "https://example.test/annotation" }],
							},
						],
					},
				],
			})
		);

		const { hooks, tool } = await createEnv({
			provider: {
				openai: {
					options: {
						websearch_cited: { model: "gpt-4o-search-preview" },
					},
				},
			},
		} as Config);

		await setCredential(hooks, "openai", {
			type: "key",
			key: "test-api-key",
		});

		const result = await tool.execute({ query: "openai web search" }, createToolContext());

		expect(result).toBe(
			"OpenAI answer\n\nSources:\n[1] Search Source (https://example.test/search)\n[2] Annotation Source (https://example.test/annotation)"
		);
	});

	it("uses the OpenRouter responses endpoint when configured and auth is present", async () => {
		fetchMock.mockResolvedValueOnce(createFetchResponse(createOpenRouterResponseBody("Search result body")));

		const { hooks, tool } = await createEnv({
			provider: {
				openrouter: {
					options: {
						websearch_cited: { model: "openrouter/auto" },
					},
				},
			},
		} as Config);

		await setCredential(hooks, "openrouter", {
			type: "key",
			key: "test-openrouter-key",
		});

		const context = createToolContext();

		const result = await tool.execute({ query: "openrouter web search" }, context);

		expect(result).toContain("Search result body");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(typeof url === "string" ? url : "").toContain("https://openrouter.ai/api/v1/responses");

		const headers = (init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-openrouter-key");

		const bodyText = typeof init?.body === "string" ? init.body : "";
		const parsed = JSON.parse(bodyText) as Record<string, unknown>;
		expect(parsed.model).toBe("openrouter/auto");
		expect(parsed.store).toBe(false);
		expect(parsed.stream).toBe(false);

		const plugins = parsed.plugins;
		expect(Array.isArray(plugins)).toBe(true);
		const plugin0 =
			Array.isArray(plugins) && plugins[0] && typeof plugins[0] === "object"
				? (plugins[0] as Record<string, unknown>)
				: undefined;
		expect(plugin0?.id).toBe("web");

		const searchPromptValue = plugin0?.search_prompt;
		expect(typeof searchPromptValue === "string" ? searchPromptValue : "").toContain(
			'perform web search on "openrouter web search"'
		);
	});

	it("adds OpenRouter sources from annotations", async () => {
		fetchMock.mockResolvedValueOnce(
			createFetchResponse({
				output: [
					{
						type: "message",
						role: "assistant",
						content: [
							{
								type: "output_text",
								text: "OpenRouter answer",
								annotations: [{ title: "OpenRouter Source", url: "https://example.test/openrouter" }],
							},
						],
					},
				],
			})
		);

		const { hooks, tool } = await createEnv({
			provider: {
				openrouter: {
					options: {
						websearch_cited: { model: "openrouter/auto" },
					},
				},
			},
		} as Config);

		await setCredential(hooks, "openrouter", {
			type: "key",
			key: "test-openrouter-key",
		});

		const result = await tool.execute({ query: "openrouter web search" }, createToolContext());

		expect(result).toBe("OpenRouter answer\n\nSources:\n[1] OpenRouter Source (https://example.test/openrouter)");
	});

	it("selects the first configured provider in order", async () => {
		fetchMock.mockResolvedValueOnce(createFetchResponse(createOpenAIResponseBody("Search result body")));

		const { hooks, tool } = await createEnv({
			provider: {
				openai: {
					options: {
						websearch_cited: { model: "gpt-4o-search-preview" },
					},
				},
				google: {
					options: {
						websearch_cited: { model: "gemini-2.5-flash" },
					},
				},
			},
		} as Config);

		await setCredential(hooks, "openai", {
			type: "oauth",
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 60_000,
		});

		const context = createToolContext();

		const result = await tool.execute({ query: "openai web search" }, context);

		expect(result).toContain("Search result body");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(typeof url === "string" ? url : "").toContain("/codex/responses");
	});

	it("exports one V2 plugin definition", async () => {
		const mod = await importIndexModule();
		expect(Object.keys(mod)).toEqual(["default"]);
		expect(mod.default?.id).toBe("opencode.websearch-cited");
		expect(typeof mod.default?.setup).toBe("function");
	});

	it("registers websearch_cited exactly once", async () => {
		const { codemode, registrations } = await createEnv(WEBSEARCH_CONFIG);
		expect(registrations).toEqual(["websearch_cited"]);
		expect(codemode).toBe(false);
	});
});

type CandidateInput = NonNullable<WebSearchGenerateContentResponse["candidates"]>[number];

async function expectThrowMessage(fn: () => Promise<unknown>, match: string) {
	try {
		await fn();
		throw new Error("Expected function to throw");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toContain(match);
	}
}

type Hooks = {
	auth: Map<string, ProviderAuth>;
};

type Tool = {
	execute: (args: unknown, context: unknown) => Promise<string>;
};

type RegisteredTool = {
	name: string;
	options?: { codemode?: boolean };
	execute: (
		input: unknown,
		context: unknown
	) => Promise<{ content: ReadonlyArray<{ type: "text"; text: string } | { type: "file" }> }>;
};

async function importIndexModule(): Promise<{ default?: Plugin.Plugin }> {
	importCounter += 1;
	const mod = (await import(`./index?agent_test=${importCounter}`)) as unknown;
	if (!mod || typeof mod !== "object") {
		throw new Error("Invalid plugin module");
	}
	return mod as { default?: Plugin.Plugin };
}

async function createEnv(
	config?: Config,
	pluginOptions = selectPluginOptions(config)
): Promise<{ hooks: Hooks[]; tool: Tool; registrations: string[]; codemode: boolean | undefined }> {
	const mod = await importIndexModule();
	const plugin = mod.default;
	if (!plugin) {
		throw new Error("Missing default plugin export");
	}

	const auth = new Map<string, ProviderAuth>();
	const hooks = [{ auth }];
	const registered: RegisteredTool[] = [];
	const context = {
		options: pluginOptions,
		catalog: {
			transform: async (transform: (draft: unknown) => void) => {
				transform(createCatalogDraft(config));
				return { dispose: async () => {} };
			},
		},
		integration: {
			connection: {
				active: async (providerID: string) =>
					auth.has(providerID) ? { type: "env" as const, name: providerID } : undefined,
				resolve: async (connection: { type: string; name?: string }) =>
					connection.name ? auth.get(connection.name) : undefined,
			},
		},
		tool: {
			transform: async (transform: (draft: { add: (tool: RegisteredTool) => void }) => void) => {
				transform({ add: (tool) => registered.push(tool) });
				return { dispose: async () => {} };
			},
		},
	} as unknown as Plugin.Context;

	await plugin.setup(context);
	const selected = registered.filter((candidate) => candidate.name === "websearch_cited");
	if (selected.length !== 1) {
		throw new Error('Tool "websearch_cited" not registered');
	}
	const registeredTool = selected[0];
	if (!registeredTool) {
		throw new Error('Tool "websearch_cited" not registered');
	}
	const tool: Tool = {
		async execute(args, toolContext) {
			const output = await registeredTool.execute(args, toolContext);
			const text = output.content.find((item) => item.type === "text");
			if (text?.type !== "text") {
				throw new Error("Tool returned no text content");
			}
			return text.text;
		},
	};

	return {
		hooks,
		tool,
		registrations: registered.map((candidate) => candidate.name),
		codemode: registeredTool.options?.codemode,
	};
}

function selectPluginOptions(config?: Config): Record<string, unknown> {
	let firstInvalid: { provider: string; model: unknown } | undefined;
	for (const [provider, providerConfig] of Object.entries(config?.provider ?? {})) {
		const cited = providerConfig.options?.websearch_cited;
		if (!cited || typeof cited !== "object" || Array.isArray(cited)) {
			continue;
		}
		const model = (cited as Record<string, unknown>).model;
		if (typeof model === "string" && model.trim() !== "") {
			return { provider, model };
		}
		firstInvalid ??= { provider, model };
	}
	return firstInvalid ?? {};
}

function createCatalogDraft(config?: Config): unknown {
	return {
		provider: {
			get(providerID: string) {
				const provider = config?.provider?.[providerID];
				if (!provider) {
					return undefined;
				}
				const settings = { ...provider.options };
				delete settings.websearch_cited;
				return {
					provider: { settings },
					models: new Map(
						Object.entries(provider.models ?? {}).map(([model, value]) => [
							model,
							{ modelID: value.modelID ?? model, settings: value.options },
						])
					),
				};
			},
		},
	};
}

async function setCredential(hooks: Hooks[], providerID: string, value: TestAuth): Promise<void> {
	const auth = hooks[0]?.auth;
	if (!auth) {
		throw new Error("Missing test auth registry");
	}
	if (value.type === "key") {
		auth.set(providerID, value);
		return;
	}
	if (value.type === "oauth") {
		auth.set(providerID, {
			type: "oauth",
			methodID: value.methodID ?? "antigravity",
			access: value.access,
			refresh: value.refresh,
			expires: value.expires ?? 0,
		} as unknown as ProviderAuth);
		return;
	}
}

function createResponse(candidate: CandidateInput): WebSearchGenerateContentResponse {
	return {
		candidates: [candidate],
	};
}

function createFetchResponse(body: unknown, init?: Partial<Pick<Response, "ok" | "status" | "statusText">>): Response {
	return {
		ok: init?.ok ?? true,
		status: init?.status ?? 200,
		statusText: init?.statusText ?? "OK",
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	} as Response;
}

function createOpenAIResponseBody(text: string): unknown {
	return {
		output: [
			{
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: {
							value: text,
						},
					},
				],
			},
		],
	};
}

function createOpenRouterResponseBody(text: string): unknown {
	return {
		output_text: text,
	};
}

function createToolContext() {
	const controller = new AbortController();
	return {
		sessionID: "session",
		messageID: "message",
		agent: "agent",
		abort: controller.signal,
	};
}
