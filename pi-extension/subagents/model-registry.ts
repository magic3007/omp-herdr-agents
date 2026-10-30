import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createModelRegistryAdapter,
	isThinkingLevel,
	scopeModelRegistryAdapter,
	type ModelRegistryAdapter,
	type RoutingModel,
	type RoutingRegistrySource,
	type ThinkingLevel,
} from "../../maestro/core/routing.ts";
import { isRecord, isString } from "../../maestro/core/config/type-guards.ts";

// The host's model object carries the SDK's effort ladder (`omp`:
// `thinking.efforts`), which the routing projection does not name. Keeping the
// raw model beside its projection lets the synthesized model answer with the
// host's own ladder instead of collapsing every effort to `off`.
interface HostThinking {
	efforts: string[];
}

interface HostModel {
	provider: string;
	id: string;
	thinking?: HostThinking;
}

/** The model this adapter hands to the SDK, with the host's own ladder. */
type SynthesizedModel = Model<any> & { thinking?: HostThinking };

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
 * Upstream pi names a level's provider value and marks unsupported levels with
 * `null`; `omp` names the supported efforts directly, so deriving the map keeps
 * both SDKs answering the same ladder.
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

// Scoped sessions (--models / enabledModels) resolve every model selection —
// task shortlists, exact refs, fallback alternatives — against the session's
// scoped set: out-of-scope models are invisible to spawn-time resolution.
export function sessionModelRegistry(ctx: {
	modelRegistry: RoutingRegistrySource;
	scopedModels?: readonly { model: { provider: string; id: string } }[];
}): ModelRegistryAdapter {
	const registry = wrapPiModelRegistry(ctx.modelRegistry);
	const scopedModels = (ctx.scopedModels ?? []).map((entry) => entry.model);
	if (scopedModels.length === 0) return registry;
	return scopeModelRegistryAdapter(
		registry,
		new Set(scopedModels.map((model) => `${model.provider}/${model.id}`)),
	);
}

function asPiModel(model: RoutingModel, host?: HostModel): SynthesizedModel {
	return {
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
