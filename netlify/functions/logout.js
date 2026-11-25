const { json, clearCookie } = require('./_lib');

exports.handler = async event => {
  return json(200, { ok: true }, { 'set-cookie': clearCookie(event) });
};
