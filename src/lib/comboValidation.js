function normalizeModelName(model) {
  if (typeof model === "string") return model.trim();
  if (model && typeof model.value === "string") return model.value.trim();
  return "";
}

function buildComboMap(combos, candidate) {
  const comboMap = new Map();

  for (const combo of combos || []) {
    if (!combo?.name || combo.id === candidate.id) continue;
    comboMap.set(combo.name, combo);
  }

  comboMap.set(candidate.name, candidate);
  return comboMap;
}

export function validateComboReferences({ comboId = null, name, models = [], combos = [] }) {
  const comboName = typeof name === "string" ? name.trim() : "";
  if (!comboName) return { valid: false, error: "Name is required" };

  const candidate = {
    id: comboId,
    name: comboName,
    models: Array.isArray(models) ? models.map(normalizeModelName).filter(Boolean) : []
  };
  const comboMap = buildComboMap(combos, candidate);

  if (candidate.models.includes(comboName)) {
    return { valid: false, error: "Combo cannot include itself as a model" };
  }

  const visiting = new Set();

  function visit(currentName, path) {
    if (currentName === comboName && path.length > 0) {
      return [...path, comboName];
    }
    if (visiting.has(currentName)) {
      return [...path, currentName];
    }

    const combo = comboMap.get(currentName);
    if (!combo) return null;

    visiting.add(currentName);
    const comboModels = Array.isArray(combo.models) ? combo.models : [];

    for (const model of comboModels) {
      const modelName = normalizeModelName(model);
      if (!comboMap.has(modelName)) continue;

      const cycle = visit(modelName, [...path, currentName]);
      if (cycle) return cycle;
    }

    visiting.delete(currentName);
    return null;
  }

  const cycle = visit(comboName, []);
  if (cycle) {
    return {
      valid: false,
      error: `Combo models cannot contain circular references: ${cycle.join(" -> ")}`
    };
  }

  return { valid: true };
}
