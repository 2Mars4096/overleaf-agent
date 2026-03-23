import { URL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const CookieXMLHttpRequest = function () {
  const self = this;

  let request;
  let response;
  let settings = {};

  const defaultHeaders = {
    'User-Agent': 'node-XMLHttpRequest',
    Accept: '*/*',
  };

  let headers = defaultHeaders;

  // Keep Cookie enabled so the socket.io v0 polling handshake can reuse a browser session.
  const forbiddenRequestHeaders = [
    'accept-charset',
    'accept-encoding',
    'access-control-request-headers',
    'access-control-request-method',
    'connection',
    'content-length',
    'content-transfer-encoding',
    'cookie2',
    'date',
    'expect',
    'host',
    'keep-alive',
    'origin',
    'referer',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'via',
  ];

  const forbiddenRequestMethods = ['TRACE', 'TRACK', 'CONNECT'];
  let sendFlag = false;
  let errorFlag = false;
  const listeners = {};

  this.UNSENT = 0;
  this.OPENED = 1;
  this.HEADERS_RECEIVED = 2;
  this.LOADING = 3;
  this.DONE = 4;

  this.readyState = this.UNSENT;
  this.onreadystatechange = null;
  this.responseText = '';
  this.responseXML = '';
  this.status = null;
  this.statusText = null;

  const isAllowedHttpHeader = function (header) {
    return header && forbiddenRequestHeaders.indexOf(header.toLowerCase()) === -1;
  };

  const isAllowedHttpMethod = function (method) {
    return method && forbiddenRequestMethods.indexOf(method) === -1;
  };

  this.open = function (method, url, async, user, password) {
    this.abort();
    errorFlag = false;

    if (!isAllowedHttpMethod(method)) {
      throw new Error('SecurityError: Request method not allowed');
    }

    settings = {
      method,
      url: url.toString(),
      async: typeof async !== 'boolean' ? true : async,
      user: user || null,
      password: password || null,
    };

    setState(this.OPENED);
  };

  this.setRequestHeader = function (header, value) {
    if (this.readyState !== this.OPENED) {
      throw new Error('INVALID_STATE_ERR: setRequestHeader can only be called when state is OPEN');
    }
    if (!isAllowedHttpHeader(header)) {
      console.warn(`Refused to set unsafe header "${header}"`);
      return;
    }
    if (sendFlag) {
      throw new Error('INVALID_STATE_ERR: send flag is true');
    }
    headers[header] = value;
  };

  this.getResponseHeader = function (header) {
    if (
      typeof header === 'string' &&
      this.readyState > this.OPENED &&
      response.headers[header.toLowerCase()] &&
      !errorFlag
    ) {
      return response.headers[header.toLowerCase()];
    }

    return null;
  };

  this.getAllResponseHeaders = function () {
    if (this.readyState < this.HEADERS_RECEIVED || errorFlag) {
      return '';
    }

    let result = '';
    for (const key in response.headers) {
      if (key !== 'set-cookie' && key !== 'set-cookie2') {
        result += key + ': ' + response.headers[key] + '\r\n';
      }
    }
    return result.substr(0, result.length - 2);
  };

  this.getRequestHeader = function (name) {
    if (typeof name === 'string' && headers[name]) {
      return headers[name];
    }
    return '';
  };

  this.send = function (data) {
    if (this.readyState !== this.OPENED) {
      throw new Error('INVALID_STATE_ERR: connection must be opened before send() is called');
    }

    if (sendFlag) {
      throw new Error('INVALID_STATE_ERR: send has already been called');
    }

    let host;
    let ssl = false;
    let local = false;
    const url = new URL(settings.url);

    switch (url.protocol) {
      case 'https:':
        ssl = true;
        host = url.hostname;
        break;
      case 'http:':
        host = url.hostname;
        break;
      case 'file:':
        local = true;
        break;
      case undefined:
      case '':
        host = '127.0.0.1';
        break;
      default:
        throw new Error('Protocol not supported.');
    }

    if (local) {
      if (settings.method !== 'GET') {
        throw new Error('XMLHttpRequest: Only GET method is supported');
      }

      if (settings.async) {
        fs.readFile(url.pathname, 'utf8', (error, fileData) => {
          if (error) {
            self.handleError(error);
          } else {
            self.status = 200;
            self.responseText = fileData;
            setState(self.DONE);
          }
        });
      } else {
        try {
          this.responseText = fs.readFileSync(url.pathname, 'utf8');
          this.status = 200;
          setState(this.DONE);
        } catch (error) {
          this.handleError(error);
        }
      }

      return;
    }

    const port = url.port || (ssl ? 443 : 80);
    const uri = url.pathname + (url.search ? url.search : '');

    headers.Host = host;
    if (!((ssl && port === 443) || port === 80)) {
      headers.Host += ':' + url.port;
    }

    if (settings.user) {
      if (typeof settings.password === 'undefined') {
        settings.password = '';
      }
      const authBuffer = Buffer.from(settings.user + ':' + settings.password);
      headers.Authorization = 'Basic ' + authBuffer.toString('base64');
    }

    if (settings.method === 'GET' || settings.method === 'HEAD') {
      data = null;
    } else if (data) {
      headers['Content-Length'] = Buffer.byteLength(data);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'text/plain;charset=UTF-8';
      }
    } else if (settings.method === 'POST') {
      headers['Content-Length'] = 0;
    }

    const options = {
      host,
      port,
      path: uri,
      method: settings.method,
      headers,
    };

    errorFlag = false;

    if (settings.async) {
      const doRequest = ssl ? https.request : http.request;
      sendFlag = true;
      self.dispatchEvent('readystatechange');

      request = doRequest(options, resp => {
        response = resp;
        response.setEncoding('utf8');

        setState(self.HEADERS_RECEIVED);
        self.status = response.statusCode;

        response.on('data', chunk => {
          if (chunk) {
            self.responseText += chunk;
          }
          if (sendFlag) {
            setState(self.LOADING);
          }
        });

        response.on('end', () => {
          if (sendFlag) {
            setState(self.DONE);
            sendFlag = false;
          }
        });

        response.on('error', error => {
          self.handleError(error);
        });
      }).on('error', error => {
        self.handleError(error);
      });

      if (data) {
        request.write(data);
      }
      request.end();
      self.dispatchEvent('loadstart');
    } else {
      const syncFile = '.node-xmlhttprequest-sync-' + process.pid;
      fs.writeFileSync(syncFile, '', 'utf8');
      const execString =
        "var http = require('http'), https = require('https'), fs = require('fs');" +
        'var doRequest = http' +
        (ssl ? 's' : '') +
        '.request;' +
        'var options = ' +
        JSON.stringify(options) +
        ';' +
        "var responseText = '';" +
        'var req = doRequest(options, function(response) {' +
        "response.setEncoding('utf8');" +
        "response.on('data', function(chunk) {" +
        'responseText += chunk;' +
        '});' +
        "response.on('end', function() {" +
        "fs.writeFileSync('" +
        syncFile +
        "', 'NODE-XMLHTTPREQUEST-STATUS:' + response.statusCode + ',' + responseText, 'utf8');" +
        '});' +
        "response.on('error', function(error) {" +
        "fs.writeFileSync('" +
        syncFile +
        "', 'NODE-XMLHTTPREQUEST-ERROR:' + JSON.stringify(error), 'utf8');" +
        '});' +
        "}).on('error', function(error) {" +
        "fs.writeFileSync('" +
        syncFile +
        "', 'NODE-XMLHTTPREQUEST-ERROR:' + JSON.stringify(error), 'utf8');" +
        '});' +
        (data ? "req.write('" + data.replace(/'/g, "\\'") + "');" : '') +
        'req.end();';
      const syncProcess = spawn(process.argv[0], ['-e', execString]);
      while ((self.responseText = fs.readFileSync(syncFile, 'utf8')) === '') {
        // Busy wait matches the old XMLHttpRequest shim and is only used for sync mode.
      }
      syncProcess.stdin.end();
      fs.unlinkSync(syncFile);
      if (self.responseText.match(/^NODE-XMLHTTPREQUEST-ERROR:/)) {
        const errorObject = self.responseText.replace(/^NODE-XMLHTTPREQUEST-ERROR:/, '');
        self.handleError(errorObject);
      } else {
        self.status = self.responseText.replace(/^NODE-XMLHTTPREQUEST-STATUS:([0-9]*),.*/, '$1');
        self.responseText = self.responseText.replace(/^NODE-XMLHTTPREQUEST-STATUS:[0-9]*,(.*)/, '$1');
        setState(self.DONE);
      }
    }
  };

  this.handleError = function (error) {
    this.status = 503;
    this.statusText = error;
    this.responseText = error?.stack || String(error);
    errorFlag = true;
    setState(this.DONE);
  };

  this.abort = function () {
    if (request) {
      request.abort();
      request = null;
    }

    headers = defaultHeaders;
    this.responseText = '';
    this.responseXML = '';
    errorFlag = true;

    if (
      this.readyState !== this.UNSENT &&
      (this.readyState !== this.OPENED || sendFlag) &&
      this.readyState !== this.DONE
    ) {
      sendFlag = false;
      setState(this.DONE);
    }
    this.readyState = this.UNSENT;
  };

  this.addEventListener = function (event, callback) {
    if (!(event in listeners)) {
      listeners[event] = [];
    }
    listeners[event].push(callback);
  };

  this.removeEventListener = function (event, callback) {
    if (event in listeners) {
      listeners[event] = listeners[event].filter(listener => listener !== callback);
    }
  };

  this.dispatchEvent = function (event) {
    if (typeof self['on' + event] === 'function') {
      self['on' + event]();
    }
    if (event in listeners) {
      for (let index = 0; index < listeners[event].length; index += 1) {
        listeners[event][index].call(self);
      }
    }
  };

  function setState(state) {
    if (self.readyState !== state) {
      self.readyState = state;

      if (settings.async || self.readyState < self.OPENED || self.readyState === self.DONE) {
        self.dispatchEvent('readystatechange');
      }

      if (self.readyState === self.DONE && !errorFlag) {
        self.dispatchEvent('load');
        self.dispatchEvent('loadend');
      }
    }
  }
};
