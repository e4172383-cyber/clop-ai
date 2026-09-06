export function availablePlans(model, planKeys, promo, now = Date.now()) {
  return [...model.plans];
}
export function selectModel(models, key, plan, defaultKey, planKeys, promo, now = Date.now()) {
  const model = models[key] || models[defaultKey];
  return availablePlans(model, planKeys, promo, now).includes(plan) ? model : models[defaultKey];
}
