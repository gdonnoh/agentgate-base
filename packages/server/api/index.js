const { handle } = require("hono/vercel");
const app = require("../dist/index").default;

module.exports = handle(app);
