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

module.exports = router;
