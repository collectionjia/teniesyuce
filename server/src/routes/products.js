const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const productService = require('../services/product');
const pricing = require('../services/pricing');

const router = express.Router();

async function loadUserPricingContext(userId) {
  const [[user]] = await pool.query(
    'SELECT id, role, commission_rate FROM users WHERE id=?',
    [userId]
  );
  return user || null;
}

function mapProductForUser(row, user) {
  const base = productService.mapProductRow(row);
  const prices = pricing.mapProductPrices(row, user);
  return { ...base, ...prices };
}

router.get('/', auth(), async (req, res) => {
  try {
    await productService.ensureProductColumns();
    const user = await loadUserPricingContext(req.user.id);
    const sql = 'SELECT * FROM products WHERE online=1 ORDER BY id';
    const [rows] = await pool.query(sql);
    res.json({ products: rows.map((p) => mapProductForUser(p, user)) });
  } catch (e) {
    res.status(500).json({ error: '获取产品失败' });
  }
});

router.get('/:id', auth(), async (req, res) => {
  try {
    await productService.ensureProductColumns();
    const user = await loadUserPricingContext(req.user.id);
    const [[p]] = await pool.query('SELECT * FROM products WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ error: '产品不存在' });
    if (!p.online) {
      return res.status(404).json({ error: '产品已下架' });
    }
    res.json({ product: mapProductForUser(p, user) });
  } catch (e) {
    res.status(500).json({ error: '获取产品失败' });
  }
});

module.exports = router;
