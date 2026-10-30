import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createModelRegistryAdapter,
	isThinkingLevel,
	type ModelRegistryAdapter,
	type RoutingModel,
	type RoutingRegistrySource,
	type ThinkingLevel,
} from "../../core/routing.ts";
import { isRecord, isString } from "../../core/config/type-guards.ts";

/** The host model's effort ladder (`omp`: `thinking.efforts`). */
interface HostThinking {
	efforts: string[];
}

/** The host model facts this adapter reads. */
interface HostModel {
	provider: string;
	id: string;
	thinking?: HostThinking;
}

/** The model this adapter hands to the SDK, with the host's own ladder. */
type SynthesizedModel = Model<any> & { thinking?: HostThinking };

/** Parse the host model the registry returned. */
function parseHostModel(raw: HostModel): HostModel | undefined {
	if (!isRecord(raw)) return undefined;
	if (!isString(raw.provider) || !isString(raw.id)) return undefined;
	const model: HostModel = { provider: raw.provider, id: raw.id };
	if (isRecord(raw.thinking) && Array.isArray(raw.thinking.efforts)) {
		model.thinking = { efforts: raw.thinking.efforts.filter(isString) };
	}
	return model;
}

/** Every thinking level an SDK may name, least intensive first. */
const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * The host's effort ladder as pi's level map, for SDKs that read only that.
 *
 * Upstream pi names a level's provider value and marks unsupported levels
 * with `null`; `omp` names the supported efforts directly. Deriving the map
 * keeps both SDKs answering the same ladder.
 */
function ladderFromEfforts(
	thinking: HostThinking | undefined,
): Partial<Record<ThinkingLevel, string | null>> | undefined {
	if (!thinking) return undefined;
	const ladder: Partial<Record<ThinkingLevel, string | null>> = {};
	for (const level of THINKING_LEVELS) ladder[level] = null;
	for (const effort of thinking.efforts)
		if (isThinkingLevel(effort)) ladder[effort] = effort;
	return ladder;
}

export function wrapPiModelRegistry(
	registry: RoutingRegistrySource,
): ModelRegistryAdapter {
	// The host model owns the SDK's effort ladder (`omp`: `thinking.efforts`),
	// which the routing projection does not name. The raw model is kept beside
	// its projection so the derived capabilities can read that ladder without
	// querying the source a second time.
	const hostModels = new Map<string, HostModel>();
	const remember = (raw: HostModel) => {
		const parsed = parseHostModel(raw);
		if (parsed) hostModels.set(`${parsed.provider}/${parsed.id}`, parsed);
	};
	const getAvailable = registry.getAvailable;
	const getAll = registry.getAll;
	const hasConfiguredAuth = registry.hasConfiguredAuth;
	const source: RoutingRegistrySource = {
		find(provider, id) {
			const raw = registry.find.call(registry, provider, id);
			remember(raw);
			return raw;
		},
		getAvailable: getAvailable
			? () => {
					const models = getAvailable.call(registry);
					for (const model of models) remember(model);
					return models;
				}
			: undefined,
		getAll: getAll
			? () => {
					const models = getAll.call(registry);
					for (const model of models) remember(model);
					return models;
				}
			: undefined,
		hasConfiguredAuth: hasConfiguredAuth
			? (model) => hasConfiguredAuth.call(registry, model)
			: undefined,
	};
	return createModelRegistryAdapter(source, {
		supportedThinkingLevels: (model) =>
			getSupportedThinkingLevels(
				asPiModel(model, hostModels.get(`${model.provider}/${model.id}`)),
			),
		clampThinkingLevel: (model, level) =>
			clampThinkingLevel(
				asPiModel(model, hostModels.get(`${model.provider}/${model.id}`)),
				level,
			),
	});
}

function asPiModel(model: RoutingModel, host?: HostModel): SynthesizedModel {
	return {
		// The routing projection names only the fields this adapter reads; the
		// host's own model carries the SDK's effort ladder, which the
		// projection drops.
		...model,
		provider: model.provider,
		id: model.id,
		name: model.id,
		api: "openai-completions",
		baseUrl: "",
		reasoning: model.reasoning,
		thinkingLevelMap:
			model.thinkingLevelMap ?? ladderFromEfforts(host?.thinking),
		input: model.input?.filter(
			(entry): entry is "text" | "image" =>
				entry === "text" || entry === "image",
		) ?? ["text"],
		contextWindow: model.contextWindow ?? 0,
		maxTokens: model.maxTokens ?? 0,
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cacheRead ?? 0,
			cacheWrite: model.cost?.cacheWrite ?? 0,
		},
		thinking: host?.thinking,
	};
}
