const { configured } = require('../lib/fugle-rate-limit');
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    configured: Boolean(process.env.FUGLE_API_KEY),
    rateLimiterConfigured: configured(),
    restLimitPerMinute: 40,
    provider: 'Fugle Market Data API',
    message: process.env.FUGLE_API_KEY ? 'Fugle API 金鑰已設定' : '尚未設定 FUGLE_API_KEY'
  });
};
