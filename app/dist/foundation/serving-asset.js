import { digestOf } from "../records/digest.js";
//#region server/foundation/serving-asset.ts
var ServingDefinitionError = class extends Error {};
/**
* Everything about matching that folds case, in one place, with the assumption it rests on named.
*
* **Assumed: an estate does not hold two things whose names differ only in case.** Unity Catalog is
* documented as case-insensitive for identifiers, and this has not been measured here. What the
* assumption costs if it is wrong is a definition naming one of two distinct relations and matching
* both; what folding buys is that a customer who types `Main.Sales.Orders` gets the table
* `information_schema` reports as `main.sales.orders`, rather than an empty population and no reason.
*
* Tag keys and values fold too, and values are where it matters most: a value is typed by a person, so
* `Gold` and `gold` are one convention entered twice. The cost is the same and the frequency is higher.
*/
function fold(value) {
	return value.trim().toLowerCase();
}
/** The matching key for a table, built here and never parsed back. */
function qualify(name) {
	return [
		fold(name.catalog),
		fold(name.schema),
		fold(name.table)
	].join(".");
}
function securableKey(on) {
	if (on.level === "catalog") return fold(on.catalog);
	if (on.level === "schema") return [fold(on.catalog), fold(on.schema)].join(".");
	return [
		fold(on.catalog),
		fold(on.schema),
		fold(on.table)
	].join(".");
}
/** The securable key of `name` at `level`, which is what a tag at that level would be on. */
function keyAt(name, level) {
	if (level === "catalog") return fold(name.catalog);
	if (level === "schema") return [fold(name.catalog), fold(name.schema)].join(".");
	return qualify(name);
}
/**
* A draft, checked and put in canonical form, or an error saying which part of it was not a definition.
*
* Every refusal here is one of two kinds. Some are the ordinary ones a stored record needs — a blank
* identifier, the same thing declared twice, a list that can never match. The rest are this module's
* subject: a definition that would classify an asset by its name. Those are refused rather than
* sanitised, because a pattern silently read as a literal name is a definition that selects nothing and
* reads as a definition that selects a hundred tables.
*/
function defineServing(draft, version) {
	if (!Number.isInteger(version) || version < 1) throw new ServingDefinitionError(`A version is a whole number from 1, and ${String(version)} is not.`);
	const named = namedAssets(draft.named ?? []);
	const tagged = selectors(draft.tagged ?? []);
	if (named.length === 0 && tagged.length === 0) throw new ServingDefinitionError("A serving definition that names no assets and no tag would declare nothing to be served. Name the assets, or the tag that marks them.");
	const requiredTagKeys = keys(draft.requiredTagKeys ?? []);
	const requiredMetadata = [...new Set(draft.requiredMetadata ?? [])].sort();
	const policy = matrix(draft.policy ?? []);
	return {
		version,
		named,
		tagged,
		requiredTagKeys,
		requiredMetadata,
		policy,
		fingerprint: digestOf({
			named,
			tagged,
			requiredTagKeys,
			requiredMetadata,
			policy
		})
	};
}
/**
* Anything that would make an identifier match more than the one thing it names.
*
* The wildcards are the obvious half. The quoting characters are the half that has to be said out loud:
* a customer pasting `` `main`.`gold`.`orders` `` out of a notebook has given three identifiers that
* are not the three the catalogue reports, and accepting them would produce an asset that silently
* never matches. Refusing names the paste; stripping the backticks would be this module deciding what
* somebody's identifier is.
*/
const NOT_AN_IDENTIFIER = /[*%?`"[\]]/u;
function identifier(value, what) {
	const trimmed = value.trim();
	if (trimmed === "") throw new ServingDefinitionError(`A blank ${what} names nothing. Name the one that was meant, or remove it.`);
	if (NOT_AN_IDENTIFIER.test(trimmed)) throw new ServingDefinitionError(`"${trimmed}" is not a ${what}: it holds a wildcard or a quote. A serving asset is named or tagged, never matched by a pattern — a pattern is the name inference this definition exists to refuse.`);
	return trimmed;
}
function namedAssets(assets) {
	const seen = /* @__PURE__ */ new Map();
	for (const asset of assets) {
		const name = {
			catalog: identifier(asset.catalog, "catalog"),
			schema: identifier(asset.schema, "schema"),
			table: identifier(asset.table, "table")
		};
		seen.set(qualify(name), name);
	}
	return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, name]) => name);
}
const LEVELS = [
	"catalog",
	"schema",
	"table"
];
function selectors(tagged) {
	const kept = /* @__PURE__ */ new Map();
	for (const selector of tagged) {
		const key = fold(identifier(selector.key, "tag key"));
		if (selector.at.length === 0) throw new ServingDefinitionError(`The ${key} selector says nothing about where the tag has to be. Name at least one of catalog, schema or table — a tag on a catalog says every table under it is served, which is a larger claim than a tag on one table and should be made deliberately.`);
		const at = LEVELS.filter((level) => selector.at.includes(level));
		if (at.length === 0) throw new ServingDefinitionError(`The ${key} selector names no level this build knows: ${selector.at.join(", ")}. A tag sits on a catalog, a schema or a table.`);
		if (selector.values != null && selector.values.length === 0) throw new ServingDefinitionError(`The ${key} selector accepts no values, so it can never match anything. Leave the values out to accept any value of the key.`);
		const values = selector.values == null ? void 0 : [...new Set(selector.values.map((value) => fold(identifier(value, "tag value"))))].sort();
		const folded = {
			key,
			...values != null ? { values } : {},
			at
		};
		if (kept.has(key)) throw new ServingDefinitionError(`The tag key ${key} is selected on twice. One key has one selector, so say which of them is meant.`);
		kept.set(key, folded);
	}
	return [...kept.values()].sort((a, b) => a.key.localeCompare(b.key));
}
function keys(required) {
	return [...new Set(required.map((key) => fold(identifier(key, "tag key"))))].sort();
}
function matrix(policy) {
	const kept = /* @__PURE__ */ new Map();
	for (const rule of policy) {
		const classification = fold(identifier(rule.classification, "classification"));
		if (rule.requires.length === 0) throw new ServingDefinitionError(`The rule for ${classification} requires no protection, which is what having no rule for it already means. Remove it, or say what it requires.`);
		if (kept.has(classification)) throw new ServingDefinitionError(`There are two rules for ${classification}. A classification has one rule, so say which is meant.`);
		kept.set(classification, {
			classification,
			requires: [...new Set(rule.requires)].sort()
		});
	}
	return [...kept.values()].sort((a, b) => a.classification.localeCompare(b.classification));
}
/**
* The population a definition selects out of what was read.
*
* Named assets are matched against the catalogue rather than trusted, because the definition is written
* once and read every run, and a table that has since been dropped is a member this app cannot say
* anything about. A tagged asset is by construction in the catalogue: it was found by walking it.
*
* A table matched by both is `named`. The reasons are not ranked by strength — they are ranked by which
* one a reader can act on, and "you named this" is a sentence with somebody in it.
*/
function servingPopulation(definition, evidence) {
	const catalogued = evidence.catalogued ?? [];
	const byName = new Map(catalogued.map((asset) => [qualify(asset.name), asset.name]));
	const assets = /* @__PURE__ */ new Map();
	const missing = [];
	for (const name of definition.named) {
		const key = qualify(name);
		const held = byName.get(key);
		if (held == null) {
			if (evidence.catalogued != null) missing.push(name);
			continue;
		}
		assets.set(key, {
			name: held,
			qualified: key,
			because: { kind: "named" }
		});
	}
	const tagged = /* @__PURE__ */ new Map();
	for (const tag of evidence.tags ?? []) {
		const selector = definition.tagged.find((one) => one.key === fold(tag.key));
		if (selector == null) continue;
		const value = fold(tag.value);
		if (selector.values != null && !selector.values.includes(value)) continue;
		const level = tag.on.level;
		if (!selector.at.includes(level)) continue;
		const on = securableKey(tag.on);
		for (const asset of catalogued) {
			if (keyAt(asset.name, level) !== on) continue;
			const key = qualify(asset.name);
			if (assets.has(key)) continue;
			const because = {
				kind: "tagged",
				key: selector.key,
				value,
				at: level
			};
			const held = tagged.get(key);
			if (held == null || nearer(because, held) < 0) tagged.set(key, because);
		}
	}
	for (const [key, because] of tagged) {
		const asset = byName.get(key);
		if (asset != null) assets.set(key, {
			name: asset,
			qualified: key,
			because
		});
	}
	return {
		assets: [...assets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, asset]) => asset),
		missing: missing.sort((a, b) => qualify(a).localeCompare(qualify(b))),
		catalogueUnread: evidence.catalogued == null,
		tagsUnread: evidence.tags == null
	};
}
const NEARNESS = {
	table: 0,
	schema: 1,
	catalog: 2
};
/**
* Which of two tags gets to be the reason, where more than one put an asset in the population.
*
* The nearest tag wins — a tag on the table over one on its schema over one on its catalog — and ties
* are broken on the key and then the value, both of which are already folded. What matters more than
* which rule this is, is that there is one: without it the sentence a reader sees is decided by the
* order the caller's rows came back in, which is a property of a SQL statement nobody wrote down.
*/
function nearer(one, other) {
	if (NEARNESS[one.at] !== NEARNESS[other.at]) return NEARNESS[one.at] - NEARNESS[other.at];
	if (one.key !== other.key) return one.key.localeCompare(other.key);
	return one.value.localeCompare(other.value);
}
/**
* What each serving asset owes under the metadata half, and whether it has it.
*
* This is the half that applies to everything in the population, and the only reason an asset is
* exempt from any of it is that the definition did not ask. An asset the evidence cannot speak to is
* `unmeasured` and stays in the population — a readiness dimension counts it in its denominator and
* says so, which is the audit's "missing or unreadable evidence is unmeasured rather than failed".
*/
function metadataReadings(definition, population, evidence) {
	const held = new Map((evidence.catalogued ?? []).map((asset) => [qualify(asset.name), asset]));
	const tagged = /* @__PURE__ */ new Map();
	for (const tag of evidence.tags ?? []) {
		if (tag.on.level !== "table") continue;
		const key = securableKey(tag.on);
		const keys = tagged.get(key) ?? /* @__PURE__ */ new Set();
		keys.add(fold(tag.key));
		tagged.set(key, keys);
	}
	return population.assets.map((asset) => {
		const unread = [];
		const carried = tagged.get(asset.qualified) ?? /* @__PURE__ */ new Set();
		const missingTagKeys = evidence.tags == null ? [] : definition.requiredTagKeys.filter((key) => !carried.has(key));
		if (evidence.tags == null && definition.requiredTagKeys.length > 0) unread.push("tags");
		const row = held.get(asset.qualified);
		const missingMetadata = [];
		for (const field of definition.requiredMetadata) {
			const value = row == null ? void 0 : field === "description" ? row.description : row.owner;
			if (value === void 0) {
				unread.push(field);
				continue;
			}
			if (value == null || value.trim() === "") missingMetadata.push(field);
		}
		const standing = unread.length > 0 ? "unmeasured" : missingTagKeys.length > 0 || missingMetadata.length > 0 ? "short" : "met";
		return {
			qualified: asset.qualified,
			standing,
			missingTagKeys,
			missingMetadata,
			unread
		};
	});
}
/**
* What each serving asset owes under the policy half, which is nothing unless a class says otherwise.
*
* Three states rather than two, and the third is why this is a separate function from the metadata
* half. An asset with no classification requiring protection is `not-required` — not passing, not
* failing, not applicable. Rolling that into `met` would let an estate that classifies nothing report
* full marks on the policy dimension, which is the exact inversion of what the dimension is for.
*
* An empty matrix means the customer has declared no protection rules, so every asset is
* `not-required` and `45c` reports the dimension as undeclared rather than as passed.
*/
function policyReadings(definition, population, evidence) {
	const classes = /* @__PURE__ */ new Map();
	for (const fact of evidence.classifications ?? []) {
		const key = qualify(fact.on);
		const held = classes.get(key) ?? /* @__PURE__ */ new Set();
		held.add(fold(fact.classification));
		classes.set(key, held);
	}
	const protections = /* @__PURE__ */ new Map();
	for (const fact of evidence.protections ?? []) {
		const key = qualify(fact.on);
		const held = protections.get(key) ?? /* @__PURE__ */ new Set();
		held.add(fact.protection);
		protections.set(key, held);
	}
	return population.assets.map((asset) => {
		const on = [...classes.get(asset.qualified) ?? /* @__PURE__ */ new Set()];
		const rules = definition.policy.filter((rule) => on.includes(rule.classification));
		const classifications = rules.map((rule) => rule.classification).sort();
		const required = [...new Set(rules.flatMap((rule) => rule.requires))].sort();
		if (evidence.classifications == null) return {
			qualified: asset.qualified,
			standing: "unmeasured",
			classifications: [],
			required: [],
			held: [],
			missing: []
		};
		if (required.length === 0) return {
			qualified: asset.qualified,
			standing: "not-required",
			classifications,
			required,
			held: [],
			missing: []
		};
		if (evidence.protections == null) return {
			qualified: asset.qualified,
			standing: "unmeasured",
			classifications,
			required,
			held: [],
			missing: []
		};
		const held = [...protections.get(asset.qualified) ?? /* @__PURE__ */ new Set()].sort();
		if (required.filter((one) => (evidence.unreadProtections ?? []).includes(one)).length > 0) return {
			qualified: asset.qualified,
			standing: "unmeasured",
			classifications,
			required,
			held,
			missing: []
		};
		const missing = required.filter((one) => !held.includes(one));
		return {
			qualified: asset.qualified,
			standing: missing.length === 0 ? "met" : "short",
			classifications,
			required,
			held,
			missing
		};
	});
}
//#endregion
export { ServingDefinitionError, defineServing, metadataReadings, policyReadings, qualify, servingPopulation };
