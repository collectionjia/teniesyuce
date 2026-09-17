/** 公开 /today 默认原始采集；站内会员列表传 applyCondition=1 再套条件组 */
function wantApplyCondition(req) {
  const v = String(req.query?.applyCondition ?? req.query?.filtered ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

async function bundleWithOptionalCondition(req, bucket, bundle) {
  if (!bundle || !wantApplyCondition(req)) return bundle;
  const rawPid = req.query?.productId ?? req.query?.product_id;
  const productId = rawPid != null && String(rawPid).trim() ? String(rawPid).trim() : null;
  const tennisConditionApply = require('./tennisConditionApply');
  return tennisConditionApply.maybeApplyCondition(bucket, bundle, productId);
}

module.exports = {
  wantApplyCondition,
  bundleWithOptionalCondition,
};
