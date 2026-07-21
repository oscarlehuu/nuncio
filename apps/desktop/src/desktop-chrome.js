// Window-chrome geometry shared between the main process and (by convention)
// the web app: the renderer's fixed app-header height is 52px
// (`min-h-[52px]` in session/home headers) — keep these in sync or the macOS
// traffic lights drift off-center.
const HEADER_HEIGHT_PX = 52;
const MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX = 7;
const MAC_TRAFFIC_LIGHT_X_PX = 16;

function getMacTrafficLightPosition() {
  return {
    x: MAC_TRAFFIC_LIGHT_X_PX,
    y: Math.round(HEADER_HEIGHT_PX / 2 - MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX),
  };
}

/**
 * BrowserWindow chrome options per platform. macOS integrates the title bar
 * into the app header (hiddenInset + repositioned traffic lights); Windows
 * and Linux keep the native frame.
 */
function getWindowChromeOptions(platform) {
  if (platform !== 'darwin') return {};
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: getMacTrafficLightPosition(),
  };
}

module.exports = {
  HEADER_HEIGHT_PX,
  MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX,
  getMacTrafficLightPosition,
  getWindowChromeOptions,
};
