const { Router } = require('express');
const { auth } = require('../middleware/auth');
const tradeRecords = require('../services/tradeRecords');

const router = Router();

router.get('/', auth(), async (req, res) => {
  try {
    const product = String(req.query.product || 'all').toLowerCase();
    const limit = Number(req.query.limit || 30);
    const offset = Number(req.query.offset || 0);
    const data = await tradeRecords.listTradeRecords(req.user.id, { product, limit, offset });
    res.json(data);
  } catch (e) {
    console.error('[trades]', e);
    res.status(500).json({ error: '获取买卖记录失败' });
  }
});

router.delete('/:id', auth(), async (req, res) => {
  try {
    const data = await tradeRecords.deleteTradeRecord(req.params.id, {
      userId: req.user.id,
      tennisOnly: false,
    });
    if (!data.deleted) return res.status(404).json({ error: '记录不存在' });
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[trades/delete]', e);
    res.status(500).json({ error: '删除失败' });
  }
});

router.post('/clear', auth(), async (req, res) => {
  try {
    const product = String(req.body?.product || req.query.product || 'tennis-family').toLowerCase();
    const data = await tradeRecords.clearTradeRecords({
      userId: req.user.id,
      product: product === 'all' ? 'all' : product,
      anyUser: false,
    });
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[trades/clear]', e);
    res.status(500).json({ error: '清空失败' });
  }
});

module.exports = router;
