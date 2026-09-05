const { createSportsPolyRouter } = require("./sportsPolyFactory");

module.exports = createSportsPolyRouter({
  envUrlKey: "DOTA2_INTERNAL_URL",
  defaultUrl: "http://dota2:8781",
  productTag: "dota2",
  productNameHints: ["DOTA2"],
  sportLabel: "DOTA2",
});
