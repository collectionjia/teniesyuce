/**
 * NBA：Polymarket 盘口列表/下单（PM 隐含胜率，暂无独立 nbaelo）
 */
const express = require('express');
const { boardRouter } = require('./dota2');

const router = express.Router();

router.use((req, _res, next) => {
  req.boardSport = 'nba';
  next();
});
router.use(boardRouter);

module.exports = router;
