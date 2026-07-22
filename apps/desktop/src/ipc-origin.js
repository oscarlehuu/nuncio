'use strict';

const { fileURLToPath } = require('node:url');

function rendererUrl(event) {
  let frameUrl;
  try {
    frameUrl = event?.senderFrame?.url;
  } catch {
    return '';
  }
  if (typeof frameUrl === 'string' && frameUrl) return frameUrl;
  try {
    const senderUrl = event?.sender?.getURL?.();
    return typeof senderUrl === 'string' ? senderUrl : '';
  } catch {
    return '';
  }
}

function parseUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function appFilePath(url) {
  if (url.protocol !== 'file:') return null;
  try {
    const location = new URL(url.toString());
    location.search = '';
    location.hash = '';
    return fileURLToPath(location);
  } catch {
    return null;
  }
}

function matchesTrustedSource(candidate, source) {
  const trusted = parseUrl(source);
  if (!trusted) return false;

  if (candidate.protocol === 'http:' || candidate.protocol === 'https:') {
    return (
      (trusted.protocol === 'http:' || trusted.protocol === 'https:') &&
      candidate.origin === trusted.origin
    );
  }

  if (candidate.protocol === 'file:') {
    const candidatePath = appFilePath(candidate);
    const trustedPath = appFilePath(trusted);
    return candidatePath !== null && trustedPath !== null && candidatePath === trustedPath;
  }

  return false;
}

function isTrustedLocalRendererUrl(value, trustedSources) {
  const candidate = parseUrl(value);
  if (!candidate || !Array.isArray(trustedSources) || trustedSources.length === 0) {
    return false;
  }
  return trustedSources.some((source) => matchesTrustedSource(candidate, source));
}

function assertTrustedLocalRenderer(event, channel, trustedSources) {
  if (!isTrustedLocalRendererUrl(rendererUrl(event), trustedSources)) {
    throw new Error(`${channel} requires a trusted local renderer`);
  }
}

module.exports = {
  assertTrustedLocalRenderer,
  isTrustedLocalRendererUrl,
  rendererUrl,
};
