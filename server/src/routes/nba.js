const { createSportsPolyRouter } = require("./sportsPolyFactory");

module.exports = createSportsPolyRouter({
  envUrlKey: "NBA_INTERNAL_URL",
  defaultUrl: "http://basketball:8780",
  productTag: "nba",
  productNameHints: ["NBA", "篮球"],
  sportLabel: "NBA",
});
