const { getFugleUsage } = require('../lib/fugle-rate-limit');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const usage = await getFugleUsage();
  res.status(200).json(usage);
};
