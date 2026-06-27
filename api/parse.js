module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  var url = req.query.url || req.query.u || 'none';
  res.status(200).json({
    ok: true,
    message: 'Vercel function works!',
    yourUrl: url,
    method: req.method,
    platform: 'test'
  });
};
