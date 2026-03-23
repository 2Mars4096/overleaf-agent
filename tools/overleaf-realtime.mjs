import { createRequire } from 'node:module';
import { CookieXMLHttpRequest } from './cookie-xml-http-request.mjs';

const require = createRequire(import.meta.url);
const io = require('socket.io-client/dist/socket.io.js');

export async function runSocketSession(config, handler) {
  const originalRequest = io.util.request;
  const originalLocation = io.location;
  const originalGlobalLocation = globalThis.location;
  io.util.request = createCookieAwareRequest(config.cookieHeader);
  io.location = buildSocketLocation(config);
  globalThis.location = io.location;

  let socket;
  try {
    const joinedProject = await connectProject(config);
    socket = joinedProject.socket;
    return await handler(joinedProject);
  } finally {
    if (socket) {
      try {
        socket.disconnect();
      } catch {
        // Best-effort cleanup only.
      }
    }
    io.util.request = originalRequest;
    io.location = originalLocation;
    globalThis.location = originalGlobalLocation;
  }
}

export async function joinDoc(socket, docId, options = {}) {
  const joinOptions = {
    encodeRanges: true,
    supportsHistoryOT: true,
    ...(options.joinOptions || {}),
  };
  const fromVersion = Number.isInteger(options.fromVersion) ? options.fromVersion : -1;

  return await new Promise((resolve, reject) => {
    const callback = (error, docLines, version, updates, ranges, type = 'sharejs-text-ot') => {
      if (error) {
        reject(normalizeSocketError(error, 'joinDoc failed'));
        return;
      }
      resolve({ docLines, version, updates, ranges, type });
    };

    if (fromVersion === -1) {
      socket.emit('joinDoc', docId, joinOptions, callback);
      return;
    }

    socket.emit('joinDoc', docId, fromVersion, joinOptions, callback);
  });
}

export async function applyOtUpdate(socket, docId, update) {
  await new Promise((resolve, reject) => {
    socket.emit('applyOtUpdate', docId, update, error => {
      if (error) {
        reject(normalizeSocketError(error, 'applyOtUpdate failed'));
        return;
      }
      resolve();
    });
  });
}

function connectProject(config) {
  const socketUrl = new URL(config.socketUrl || '/socket.io', config.baseUrl);
  const resource = socketUrl.pathname.replace(/^\/+/, '') || 'socket.io';
  const origin = socketUrl.origin;
  const query = new URLSearchParams({ projectId: config.projectId }).toString();

  return awaitableConnect({
    origin,
    resource,
    query,
    timeoutMs: config.timeoutMs,
  });
}

function awaitableConnect({ origin, resource, query, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = io.connect(origin, {
      resource,
      query,
      transports: ['xhr-polling'],
      reconnect: false,
      'force new connection': true,
      'connect timeout': timeoutMs,
    });

    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error(`socket connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeListener('joinProjectResponse', onJoinProjectResponse);
      socket.removeListener('connectionRejected', onConnectionRejected);
      socket.removeListener('connect_failed', onConnectFailed);
      socket.removeListener('error', onError);
      socket.removeListener('disconnect', onDisconnect);
    };

    const succeed = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.disconnect();
      } catch {
        // ignore cleanup failures
      }
      reject(error);
    };

    const onJoinProjectResponse = response => {
      socket.publicId = response.publicId;
      succeed({ ...response, socket });
    };

    const onConnectionRejected = error => {
      fail(normalizeSocketError(error, 'socket connection rejected'));
    };

    const onConnectFailed = error => {
      fail(normalizeSocketError(error, 'socket connection failed'));
    };

    const onError = error => {
      fail(normalizeSocketError(error, 'socket error'));
    };

    const onDisconnect = () => {
      fail(new Error('socket disconnected before joinProjectResponse'));
    };

    socket.on('joinProjectResponse', onJoinProjectResponse);
    socket.on('connectionRejected', onConnectionRejected);
    socket.on('connect_failed', onConnectFailed);
    socket.on('error', onError);
    socket.on('disconnect', onDisconnect);
  });
}

function createCookieAwareRequest(cookieHeader) {
  const cookieJar = parseCookieHeader(cookieHeader);

  return function requestFactory() {
    const xhr = new CookieXMLHttpRequest();
    const originalOpen = xhr.open;
    xhr.open = function (...args) {
      originalOpen.apply(xhr, args);
      const mergedCookieHeader = formatCookieHeader(cookieJar);
      if (mergedCookieHeader) {
        xhr.setRequestHeader('Cookie', mergedCookieHeader);
      }
    };
    xhr.addEventListener('readystatechange', () => {
      if (xhr.readyState < xhr.HEADERS_RECEIVED) {
        return;
      }
      mergeSetCookieHeader(cookieJar, xhr.getResponseHeader('set-cookie'));
    });
    return xhr;
  };
}

function buildSocketLocation(config) {
  const url = new URL(config.socketUrl || '/socket.io', config.baseUrl);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
  };
}

function normalizeSocketError(error, fallbackMessage) {
  if (error instanceof Error) {
    return error;
  }
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return new Error(error.message);
  }
  return new Error(error ? String(error) : fallbackMessage);
}

function parseCookieHeader(cookieHeader) {
  const cookieJar = new Map();
  if (!cookieHeader) {
    return cookieJar;
  }

  for (const part of String(cookieHeader).split(/;\s*/)) {
    if (!part) {
      continue;
    }
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (name) {
      cookieJar.set(name, value);
    }
  }

  return cookieJar;
}

function formatCookieHeader(cookieJar) {
  return Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function mergeSetCookieHeader(cookieJar, setCookieHeader) {
  if (!setCookieHeader) {
    return;
  }

  const setCookieValues = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const cookieValue of setCookieValues) {
    if (!cookieValue) {
      continue;
    }
    const firstSegment = String(cookieValue).split(';', 1)[0];
    const separatorIndex = firstSegment.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = firstSegment.slice(0, separatorIndex).trim();
    const value = firstSegment.slice(separatorIndex + 1).trim();
    if (name) {
      cookieJar.set(name, value);
    }
  }
}
