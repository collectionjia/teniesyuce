function roundPrice(n) {
  return Math.round(Number(n) * 100) / 100;
}

function agentPrice(retailPrice, commissionRate) {
  const rate = Math.min(100, Math.max(0, Number(commissionRate) || 0));
  return roundPrice(Number(retailPrice) * rate / 100);
}

function priceKey(plan) {
  return { month: 'price_month', week: 'price_week', day: 'price_day' }[plan];
}

function retailPrice(product, plan) {
  return Number(product[priceKey(plan)]);
}

function priceForUser(product, plan, user) {
  return retailPrice(product, plan);
}

function mapProductPrices(product, user) {
  return {
    priceMonth: Number(product.price_month),
    priceWeek: Number(product.price_week),
    priceDay: Number(product.price_day),
    agentPrice: false,
  };
}

module.exports = {
  roundPrice,
  agentPrice,
  priceKey,
  retailPrice,
  priceForUser,
  mapProductPrices,
};
