const express = require('express');
const settings = require('../services/settings');

const router = express.Router();

router.get('/payment', async (_req, res) => {
  try {
    res.json(await settings.getPaymentSettings());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取支付设置失败' });
  }
});

module.exports = router;
