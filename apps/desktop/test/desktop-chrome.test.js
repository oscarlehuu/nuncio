const { describe, it, expect } = require('bun:test');
const {
  HEADER_HEIGHT_PX,
  MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX,
  getMacTrafficLightPosition,
  getWindowChromeOptions,
} = require('../src/desktop-chrome');

describe('desktop-chrome', () => {
  it('centers the traffic lights vertically in the app header', () => {
    const position = getMacTrafficLightPosition();
    expect(position.y).toBe(Math.round(HEADER_HEIGHT_PX / 2 - MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX));
    expect(position.x).toBeGreaterThan(0);
  });

  it('returns hiddenInset chrome on macOS', () => {
    const options = getWindowChromeOptions('darwin');
    expect(options.titleBarStyle).toBe('hiddenInset');
    expect(options.trafficLightPosition).toEqual(getMacTrafficLightPosition());
  });

  it('keeps the native frame on Windows and Linux', () => {
    expect(getWindowChromeOptions('win32')).toEqual({});
    expect(getWindowChromeOptions('linux')).toEqual({});
  });
});
