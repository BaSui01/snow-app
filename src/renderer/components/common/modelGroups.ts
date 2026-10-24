import { modelMappings } from "@lobehub/icons";
import type { Model } from "../../../preload";

/** 未匹配到品牌的分组键（展示名由调用方按语言兜底）。 */
export const OTHER_MODEL_GROUP_KEY = "__other__";

export type ModelGroup = {
  /** 品牌名；未匹配到品牌时为 OTHER_MODEL_GROUP_KEY。 */
  key: string;
  /** 品牌展示名；未匹配到品牌时为空串。 */
  label: string;
  /** 分组图标参照的模型 id（品牌图标按模型名匹配，取该组首个模型）。 */
  iconModel: string;
  models: Model[];
};

type BrandMatcher = {
  title: string | null;
  patterns: RegExp[];
};

let brandMatchers: BrandMatcher[] | null = null;
/** 模型名 -> 品牌名 的匹配缓存（搜索过滤会反复对同一批模型分组）。 */
const brandTitleCache = new Map<string, string | null>();

/**
 * 预编译品牌匹配规则：modelMappings 的关键字本身是正则（与 ModelBrandIcon 的匹配口径一致），
 * 整表预编译一次，避免按模型逐个构造正则。
 */
const getBrandMatchers = (): BrandMatcher[] => {
  if (!brandMatchers) {
    brandMatchers = modelMappings.map((mapping) => ({
      title: (mapping.Icon as { title?: string }).title?.trim() || null,
      patterns: mapping.keywords.map((keyword) => new RegExp(keyword, "i")),
    }));
  }
  return brandMatchers;
};

const matchBrandTitle = (modelId: string): string | null => {
  const name = modelId.trim().toLowerCase();
  if (!name) {
    return null;
  }
  const cached = brandTitleCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  let title: string | null = null;
  for (const matcher of getBrandMatchers()) {
    if (matcher.patterns.some((pattern) => pattern.test(name))) {
      title = matcher.title;
      break;
    }
  }
  brandTitleCache.set(name, title);
  return title;
};

/**
 * 按品牌把模型分组：品牌判定沿用 ModelBrandIcon 的模糊匹配（首个命中的映射即该模型品牌），
 * 同品牌归入同一组。品牌组按首次出现的顺序排列，未识别品牌的“其他”组固定排在最后。
 */
export const groupModelsByBrand = (models: Model[]): ModelGroup[] => {
  const groups: ModelGroup[] = [];
  const groupByBrand = new Map<string, ModelGroup>();
  const otherModels: Model[] = [];

  for (const model of models) {
    const title = matchBrandTitle(model.id);
    if (!title) {
      otherModels.push(model);
      continue;
    }
    let group = groupByBrand.get(title);
    if (!group) {
      group = { key: title, label: title, iconModel: model.id, models: [] };
      groupByBrand.set(title, group);
      groups.push(group);
    }
    group.models.push(model);
  }

  if (otherModels.length > 0) {
    groups.push({
      key: OTHER_MODEL_GROUP_KEY,
      label: "",
      iconModel: otherModels[0].id,
      models: otherModels,
    });
  }

  return groups;
};
