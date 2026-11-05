const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
} = require("expo/config-plugins");

const name = "colorAccent";
const withColor = (value) => (config) => {
  config.modResults = AndroidConfig.Colors.assignColorValue(config.modResults, { name, value });
  return config;
};

/** System dialogs, carets and selection handles in Nodex's accent rather than the platform's. */
module.exports = function withAndroidAccent(config, { light, dark }) {
  config = withAndroidColors(config, withColor(light));
  config = withAndroidColorsNight(config, withColor(dark));
  return withAndroidStyles(config, (config) => {
    config.modResults = AndroidConfig.Styles.assignStylesValue(config.modResults, {
      add: true,
      parent: AndroidConfig.Styles.getAppThemeGroup(),
      name,
      value: `@color/${name}`,
    });
    return config;
  });
};
