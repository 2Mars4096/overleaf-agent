#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { posix as pathPosix, resolve } from 'node:path';
import { applyOtUpdate, joinDoc, runSocketSession } from './overleaf-realtime.mjs';

const SECRET_KEYS = new Set(['cookie', 'cookieheader', 'csrf', 'csrftoken', 'authorization', 'auth', 'set-cookie', 'x-csrf-token']);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_BASE_URL = 'https://www.overleaf.com';
const DEFAULT_CONFIG_FILENAMES = ['overleaf-agent.settings.json', '.overleaf-agent.json'];
const MERGEABLE_SETTINGS_KEYS = new Set(['headers', 'endpoints', 'methods']);
const DEFAULT_PROFILE_NAME = 'personal';
const EXAMPLE_SETTINGS_URL = new URL('../overleaf-agent.settings.example.json', import.meta.url);

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

async function main() {
  const { command, options, extraArgs } = parseArgs(process.argv.slice(2));
  if (!command) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(command, options, extraArgs);
  const result = await runCommand(command, config);

  if (config.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  printResult(command, result);
}

function loadConfig(command, options, extraArgs) {
  const env = process.env;
  const requestedProfile = firstConfigured(options.profile, env.OVERLEAF_PROFILE);
  const settingsState = loadSettingsState(
    firstConfigured(options.config, env.OVERLEAF_CONFIG),
    requestedProfile,
    { allowMissing: command === 'setup' || command === 'use-project' || command === 'connect' || command === 'disconnect' || command === 'status' }
  );
  const settings = settingsState.settings;
  const baseUrl = firstConfigured(options.baseUrl, env.OVERLEAF_BASE_URL, settings.baseUrl, DEFAULT_BASE_URL);
  const cookieHeader = firstConfigured(options.cookie, env.OVERLEAF_COOKIE_HEADER, settings.cookieHeader);
  const cookieStdin = toBoolean(firstConfigured(options.cookieStdin, env.OVERLEAF_COOKIE_STDIN));
  const csrfToken = firstConfigured(options.csrf, env.OVERLEAF_CSRF_TOKEN, settings.csrfToken);
  const projectId = firstConfigured(options.projectId, env.OVERLEAF_PROJECT_ID, settings.projectId);
  const projectName = firstConfigured(env.OVERLEAF_PROJECT_NAME, settings.projectName);
  const projectRef = firstConfigured(options.project, env.OVERLEAF_PROJECT, settings.projectRef);
  const fileId = firstConfigured(options.fileId, options.docId, env.OVERLEAF_FILE_ID, env.OVERLEAF_DOC_ID, settings.fileId, settings.docId);
  const filePath = firstConfigured(options.filePath, env.OVERLEAF_FILE_PATH, settings.filePath);
  const socketUrl = firstConfigured(options.socketUrl, env.OVERLEAF_SOCKET_URL, settings.socketUrl);
  const name = firstConfigured(options.name, env.OVERLEAF_NAME, settings.name);
  const parentPath = firstConfigured(options.parentPath, env.OVERLEAF_PARENT_PATH, settings.parentPath);
  const targetPath = firstConfigured(options.targetPath, env.OVERLEAF_TARGET_PATH, settings.targetPath);
  const text = firstConfigured(options.text, env.OVERLEAF_TEXT, settings.text);
  const textFile = firstConfigured(options.textFile, env.OVERLEAF_TEXT_FILE, settings.textFile);
  const timeoutMs = numberFrom(firstConfigured(options.timeoutMs, env.OVERLEAF_TIMEOUT_MS, settings.timeoutMs), DEFAULT_TIMEOUT_MS);
  const json = toBoolean(firstConfigured(options.json, env.OVERLEAF_JSON, settings.json));
  const dryRun = toBoolean(firstConfigured(options.dryRun, env.OVERLEAF_DRY_RUN, settings.dryRun, command.startsWith('probe-')));
  const sendMutations = toBoolean(firstConfigured(options.send, env.OVERLEAF_SEND_MUTATIONS, settings.sendMutations));
  const endpoint = firstConfigured(
    options.endpoint,
    env[`OVERLEAF_${commandToEnvKey(command)}_ENDPOINT`],
    env[commandSpecificEndpointKey(command)],
    env.OVERLEAF_ENDPOINT,
    settings.endpoints?.[command],
    settings.endpoint,
  );
  const method = String(
    firstConfigured(
      options.method,
      env[`OVERLEAF_${commandToEnvKey(command)}_METHOD`],
      settings.methods?.[command],
      settings.method,
      inferMethod(command),
    )
  ).toUpperCase();
  const headers = parseHeaders(options.header, env.OVERLEAF_EXTRA_HEADERS, settings.headers);
  const body = firstConfigured(options.body, env.OVERLEAF_BODY, settings.body) || '';
  const rawArgs = extraArgs;

  return {
    command,
    baseUrl,
    cookieHeader,
    cookieStdin,
    csrfToken,
    projectId,
    projectName,
    projectRef,
    fileId,
    filePath,
    socketUrl,
    name,
    parentPath,
    targetPath,
    text,
    textFile,
    timeoutMs,
    json,
    dryRun,
    sendMutations,
    endpoint,
    method,
    headers,
    body,
    rawArgs,
    settingsPath: settingsState.path,
    settingsProfile: settingsState.profileName,
    requestedProfile,
    settingsSource: settingsState.source,
    verbose: toBoolean(options.verbose || env.OVERLEAF_VERBOSE),
  };
}

function loadSettingsState(explicitPath, requestedProfile, { allowMissing = false } = {}) {
  const path = resolveSettingsPath(explicitPath);
  if (!path) {
    if (requestedProfile && !allowMissing) {
      throw new Error(`Settings profile "${requestedProfile}" requested, but no settings file was found.`);
    }
    return { path: '', profileName: '', settings: {}, source: {} };
  }
  if (allowMissing && !existsSync(path)) {
    return { path, profileName: requestedProfile || '', settings: {}, source: {} };
  }

  const source = readSettingsFile(path);
  const { settings, profileName } = selectSettings(source, requestedProfile);
  return { path, profileName, settings, source };
}

function resolveSettingsPath(explicitPath) {
  if (firstConfigured(explicitPath)) {
    return resolve(String(explicitPath));
  }

  for (const filename of DEFAULT_CONFIG_FILENAMES) {
    const path = resolve(filename);
    if (existsSync(path)) return path;
  }

  return '';
}

function readSettingsFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read settings file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Settings file ${path} must contain a JSON object at the top level.`);
  }

  return parsed;
}

function selectSettings(source, requestedProfile) {
  const profileName = firstConfigured(requestedProfile, source.defaultProfile) || '';
  const baseSettings = stripSettingsMeta(source);
  if (!profileName) {
    return { settings: baseSettings, profileName: '' };
  }

  if (!isPlainObject(source.profiles) || !isPlainObject(source.profiles[profileName])) {
    throw new Error(`Settings profile not found: ${profileName}`);
  }

  return {
    settings: mergeSettings(baseSettings, source.profiles[profileName]),
    profileName,
  };
}

function stripSettingsMeta(source) {
  const output = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (key === '$schema' || key === 'defaultProfile' || key === 'profiles') {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function mergeSettings(base, override) {
  const output = { ...(isPlainObject(base) ? base : {}) };
  for (const [key, value] of Object.entries(isPlainObject(override) ? override : {})) {
    if (MERGEABLE_SETTINGS_KEYS.has(key) && (isPlainObject(output[key]) || isPlainObject(value))) {
      output[key] = {
        ...(isPlainObject(output[key]) ? output[key] : {}),
        ...(isPlainObject(value) ? value : {}),
      };
      continue;
    }
    output[key] = value;
  }
  return output;
}

async function runCommand(command, config) {
  switch (command) {
    case 'setup':
      return setupLocalConfig(config);
    case 'status':
      return connectionStatus(config);
    case 'connect':
      return connectSession(config);
    case 'disconnect':
      return disconnectSession(config);
    case 'validate':
      return requestCommand('validate', config, {
        defaultEndpoint: '/user/projects',
        required: ['baseUrl', 'cookieHeader'],
      });
    case 'projects':
      return listProjects(config);
    case 'use-project':
      return useProject(config);
    case 'tree':
      return requestCommand('tree', await resolveProjectConfig(config, 'tree', { required: true }), {
        defaultEndpoint: '/project/${projectId}/entities',
        required: ['baseUrl', 'cookieHeader', 'projectId'],
      });
    case 'snapshot':
      return snapshotProject(await resolveProjectConfig(config, 'snapshot', { required: true }));
    case 'read':
      return readDocument(await resolveProjectConfig(config, 'read', { required: true }));
    case 'edit':
      return editDocument(await resolveProjectConfig(config, 'edit', { required: true }));
    case 'add-doc':
      return createProjectEntity('add-doc', await resolveProjectConfig(config, 'add-doc', { required: true }), { endpoint: '/project/${projectId}/doc', type: 'doc' });
    case 'add-folder':
      return createProjectEntity('add-folder', await resolveProjectConfig(config, 'add-folder', { required: true }), { endpoint: '/project/${projectId}/folder', type: 'folder' });
    case 'rename':
      return renameProjectEntity(await resolveProjectConfig(config, 'rename', { required: true }));
    case 'move':
      return moveProjectEntity(await resolveProjectConfig(config, 'move', { required: true }));
    case 'delete':
      return deleteProjectEntity(await resolveProjectConfig(config, 'delete', { required: true }));
    case 'extract-csrf':
      return extractCsrf(await resolveProjectConfig(config, 'extract-csrf', { required: false }));
    case 'probe-write':
      return probeWrite(config);
    case 'probe-refresh':
      return probeRefresh(config);
    case 'contract':
      return buildContractSummary(config);
    case 'request':
      return requestCommand('request', config, {
        defaultEndpoint: '',
        required: ['baseUrl', 'cookieHeader'],
      });
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function requestCommand(label, config, { defaultEndpoint, required }) {
  assertRequired(config, required, label);

  const endpoint = config.endpoint || defaultEndpoint;
  if (!endpoint) {
    throw new Error(`Missing endpoint for ${label}. Set OVERLEAF_${commandToEnvKey(label)}_ENDPOINT or pass --endpoint.`);
  }

  const request = buildRequest(config, endpoint, config.method);
  if (config.dryRun) {
    return { mode: 'dry-run', request: redactAny(request, config) };
  }

  const response = await executeRequest(request, config);
  return summarizeResponse(label, request, response, config, endpoint);
}

async function setupLocalConfig(config) {
  const settingsPath = config.settingsPath || resolve(DEFAULT_CONFIG_FILENAMES[0]);
  if (existsSync(settingsPath)) {
    const source = readSettingsFile(settingsPath);
    const profileName = pickWritableProfileName(source, config.requestedProfile);
    return {
      label: 'setup',
      created: false,
      settingsPath,
      settingsProfile: profileName,
      notes: [
        'A local settings file already exists.',
        'Edit cookieHeader in that file, then run validate and projects.',
      ],
    };
  }

  const source = buildDefaultSettingsSource(config.requestedProfile);
  writeSettingsFile(settingsPath, source);
  return {
    label: 'setup',
    created: true,
    settingsPath,
    settingsProfile: source.defaultProfile,
    notes: [
      'Paste your full authenticated Cookie header into cookieHeader.',
      'Then run validate, projects, and use-project before your first edit.',
    ],
  };
}

function connectionStatus(config) {
  const connected = Boolean(config.cookieHeader);
  return {
    label: 'status',
    connected,
    settingsPath: config.settingsPath || resolve(DEFAULT_CONFIG_FILENAMES[0]),
    settingsProfile: config.settingsProfile || firstConfigured(config.requestedProfile, DEFAULT_PROFILE_NAME),
    baseUrl: config.baseUrl,
    socketUrl: resolveSocketUrl(config).toString(),
    projectId: config.projectId || '',
    projectName: config.projectName || '',
    sendMutations: config.sendMutations,
    dryRun: config.dryRun,
    notes: connected
      ? ['A stored cookieHeader is available for the active profile.']
      : ['No stored cookieHeader was found for the active profile. Use connect to save one.'],
  };
}

async function connectSession(config) {
  const settingsPath = config.settingsPath || resolve(DEFAULT_CONFIG_FILENAMES[0]);
  const source = existsSync(settingsPath) ? readSettingsFile(settingsPath) : buildDefaultSettingsSource(config.requestedProfile);
  const profileName = pickWritableProfileName(source, config.requestedProfile);
  const cookieHeader = await resolveIncomingCookie(config);
  if (!cookieHeader) {
    throw new Error('connect: missing cookie header. Provide --cookie or pass it on stdin with --cookie-stdin.');
  }

  const candidateConfig = {
    ...config,
    cookieHeader,
    dryRun: false,
  };

  if (config.dryRun) {
    return {
      label: 'connect',
      mode: 'dry-run',
      settingsPath,
      settingsProfile: profileName,
      baseUrl: config.baseUrl,
      notes: [
        'Would validate the provided cookie against /user/projects before persisting it.',
        'Would store the cookieHeader in the selected local profile on success.',
      ],
    };
  }

  const catalog = await fetchProjectCatalog(candidateConfig);

  source.defaultProfile = source.defaultProfile || profileName;
  source.profiles ??= {};
  const nextProfile = mergeSettings(source.profiles[profileName], {
    cookieHeader,
  });
  if (config.baseUrl && config.baseUrl !== DEFAULT_BASE_URL) {
    nextProfile.baseUrl = config.baseUrl;
  }
  if (config.socketUrl) {
    nextProfile.socketUrl = config.socketUrl;
  }
  if (nextProfile.csrfToken) {
    delete nextProfile.csrfToken;
  }
  source.profiles[profileName] = nextProfile;
  writeSettingsFile(settingsPath, source);

  return {
    label: 'connect',
    connected: true,
    settingsPath,
    settingsProfile: profileName,
    baseUrl: config.baseUrl,
    projectCount: catalog.projects.length,
    notes: [
      'Cookie saved and validated successfully.',
      'Use use-project to save a default project if you want path-based commands without a project id.',
    ],
  };
}

function disconnectSession(config) {
  const settingsPath = config.settingsPath || resolve(DEFAULT_CONFIG_FILENAMES[0]);
  if (!existsSync(settingsPath)) {
    return {
      label: 'disconnect',
      disconnected: false,
      settingsPath,
      notes: ['No local settings file exists, so there was nothing to clear.'],
    };
  }

  const source = readSettingsFile(settingsPath);
  const profileName = pickWritableProfileName(source, config.requestedProfile);
  source.profiles ??= {};
  const nextProfile = { ...(isPlainObject(source.profiles[profileName]) ? source.profiles[profileName] : {}) };
  delete nextProfile.cookieHeader;
  delete nextProfile.csrfToken;
  source.profiles[profileName] = nextProfile;
  writeSettingsFile(settingsPath, source);

  return {
    label: 'disconnect',
    disconnected: true,
    settingsPath,
    settingsProfile: profileName,
    notes: [
      'Stored cookieHeader and csrfToken were cleared from the selected local profile.',
    ],
  };
}

async function listProjects(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader'], 'projects');

  const request = buildRequest(config, '/user/projects', config.method);
  if (config.dryRun) {
    return {
      label: 'projects',
      mode: 'dry-run',
      request: redactAny(request, config),
      notes: [
        'Fetches the authenticated project list.',
        'Use use-project to save one project as the default target in your local settings.',
      ],
    };
  }

  const response = await executeRequest(request, config);
  const result = summarizeResponse('projects', request, response, config, '/user/projects');
  const projects = extractProjectList(parseJson(response.body));
  if (projects.length > 0) {
    result.projects = projects;
    result.projectCount = projects.length;
  }
  const selectedId = config.projectId;
  if (selectedId) {
    const selectedProject = projects.find(project => project.id === String(selectedId));
    result.selectedProjectId = String(selectedId);
    if (selectedProject?.name) {
      result.selectedProjectName = selectedProject.name;
    }
  }
  result.notes = [
    ...(result.notes || []),
    'Use use-project <name-or-id> to save a default project so later commands can omit --project-id.',
  ];
  return result;
}

async function useProject(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader'], 'use-project');
  const projectRef = firstConfigured(config.projectRef, config.rawArgs[0], config.projectName, config.projectId);
  if (!projectRef) {
    throw new Error('use-project: missing required config: project name or id');
  }

  const match = await resolveProjectReference({ ...config, dryRun: false }, projectRef);
  const settingsPath = config.settingsPath || resolve(DEFAULT_CONFIG_FILENAMES[0]);
  const source = existsSync(settingsPath) ? readSettingsFile(settingsPath) : buildDefaultSettingsSource(config.requestedProfile);
  const profileName = pickWritableProfileName(source, config.requestedProfile);
  source.defaultProfile ??= profileName;
  source.profiles ??= {};
  source.profiles[profileName] = mergeSettings(source.profiles[profileName], {
    projectId: match.id,
    projectName: match.name,
  });
  writeSettingsFile(settingsPath, source);

  return {
    label: 'use-project',
    settingsPath,
    settingsProfile: profileName,
    projectId: match.id,
    projectName: match.name,
    notes: [
      'The selected project is now stored in your local settings file.',
      'You can omit --project-id on later path-based commands while this profile is active.',
    ],
  };
}

async function resolveProjectConfig(config, label, { required }) {
  if (config.projectId && !config.projectRef) {
    return config;
  }

  const projectRef = firstConfigured(config.projectRef, config.projectName, config.rawArgs[0]);
  if (!projectRef) {
    if (required && !config.projectId) {
      throw new Error(`${label}: missing required config: projectId or project`);
    }
    return config;
  }

  if (config.dryRun) {
    return {
      ...config,
      projectId: config.projectId || '<resolved-project-id>',
    };
  }

  const match = await resolveProjectReference(config, projectRef);
  return {
    ...config,
    projectId: match.id,
    projectName: match.name,
  };
}

async function resolveProjectReference(config, projectRef) {
  const catalog = await fetchProjectCatalog(config);
  if (!catalog.projects.length) {
    throw new Error('No accessible projects were returned by /user/projects.');
  }

  const normalizedRef = String(projectRef).trim();
  const lowerRef = normalizedRef.toLowerCase();

  const exactId = catalog.projects.find(project => project.id === normalizedRef);
  if (exactId) return exactId;

  const exactName = catalog.projects.find(project => project.name === normalizedRef);
  if (exactName) return exactName;

  const exactNameInsensitive = catalog.projects.find(project => project.name.toLowerCase() === lowerRef);
  if (exactNameInsensitive) return exactNameInsensitive;

  const containsMatches = catalog.projects.filter(project => project.name.toLowerCase().includes(lowerRef));
  if (containsMatches.length === 1) {
    return containsMatches[0];
  }
  if (containsMatches.length > 1) {
    throw new Error(`Project reference "${projectRef}" is ambiguous. Matches: ${containsMatches.map(project => project.name).join(', ')}`);
  }

  throw new Error(`Project not found: ${projectRef}`);
}

async function fetchProjectCatalog(config) {
  const request = buildRequest(config, '/user/projects', 'GET');
  const response = await executeRequest(request, config);
  if (!response.ok) {
    throw new Error(`Project lookup failed: ${response.status} ${response.statusText}`);
  }
  return {
    request,
    response,
    parsedBody: parseJson(response.body),
    projects: extractProjectList(parseJson(response.body)),
  };
}

function buildDefaultSettingsSource(requestedProfile) {
  const profileName = firstConfigured(requestedProfile, DEFAULT_PROFILE_NAME);
  try {
    const source = JSON.parse(readFileSync(EXAMPLE_SETTINGS_URL, 'utf8'));
    if (profileName && profileName !== source.defaultProfile) {
      source.defaultProfile = profileName;
      source.profiles ??= {};
      source.profiles[profileName] ??= {
        cookieHeader: 'paste-the-full-Cookie-request-header-here',
      };
    }
    return source;
  } catch {
    return {
      $schema: './overleaf-agent.settings.schema.json',
      defaultProfile: profileName,
      baseUrl: DEFAULT_BASE_URL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      dryRun: false,
      sendMutations: false,
      profiles: {
        [profileName]: {
          cookieHeader: 'paste-the-full-Cookie-request-header-here',
        },
      },
    };
  }
}

function pickWritableProfileName(source, requestedProfile) {
  return String(firstConfigured(requestedProfile, source.defaultProfile, DEFAULT_PROFILE_NAME));
}

function writeSettingsFile(path, source) {
  writeFileSync(path, JSON.stringify(source, null, 2) + '\n', 'utf8');
}

async function resolveIncomingCookie(config) {
  if (config.cookieHeader) {
    return String(config.cookieHeader).trim();
  }
  if (config.cookieStdin || !process.stdin.isTTY) {
    const value = await readStdinText();
    return String(value || '').trim();
  }
  return '';
}

async function readStdinText() {
  return await new Promise((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
    });
    process.stdin.on('end', () => resolve(buffer));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

async function extractCsrf(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader'], 'extract-csrf');

  const endpoint = config.endpoint || (config.projectId ? '/Project/${projectId}' : '/project');
  const request = buildRequest(config, endpoint, 'GET', {
    accept: 'text/html,application/xhtml+xml',
  });

  if (config.dryRun) {
    return {
      mode: 'dry-run',
      request: redactAny(request, config),
      notes: [
        'Fetches an authenticated HTML page and extracts the ol-csrfToken meta tag.',
        'Use --project-id to prefer the editor page; otherwise it falls back to the project dashboard.',
      ],
    };
  }

  const response = await executeRequest(request, config);
  const extractedToken = extractMetaContent(response.body, 'ol-csrfToken');
  return {
    label: 'extract-csrf',
    endpointType: endpoint,
    found: Boolean(extractedToken),
    csrfToken: extractedToken ? '<redacted:csrfToken>' : '',
    ...summarizeResponse(
      'extract-csrf',
      request,
      response,
      extractedToken ? { ...config, csrfToken: extractedToken } : config,
      endpoint
    ),
  };
}

async function snapshotProject(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader', 'projectId'], 'snapshot');

  if (config.dryRun) {
    return {
      mode: 'dry-run',
      transport: 'socket.io-v0-xhr-polling',
      socketUrl: resolveSocketUrl(config).toString(),
      projectId: config.projectId,
      notes: [
        'Connects to the realtime service with the current browser cookie header and waits for joinProjectResponse.',
        'The snapshot contains rootFolder ids, which the public /project/:id/entities route does not expose.',
      ],
    };
  }

  const snapshot = await loadProjectSnapshot(config);
  return summarizeSnapshot(snapshot, config);
}

async function readDocument(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader', 'projectId'], 'read');
  if (!config.fileId && !config.filePath) {
    throw new Error('read: missing required config: fileId or filePath');
  }

  if (!config.fileId && config.dryRun) {
    return {
      mode: 'dry-run',
      transport: 'socket.io-v0-xhr-polling',
      socketUrl: resolveSocketUrl(config).toString(),
      projectId: config.projectId,
      path: normalizeRemotePath(config.filePath),
      notes: [
        'The file path will be resolved to a doc id from the realtime project snapshot before the HTTP download request is sent.',
      ],
    };
  }

  let resolvedTarget = {
    id: config.fileId,
    path: config.filePath ? normalizeRemotePath(config.filePath) : '',
  };

  if (!resolvedTarget.id) {
    const snapshot = await loadProjectSnapshot(config);
    const entry = resolveEntryByPath(snapshot.entries, config.filePath);
    assertEntryType(entry, ['doc'], 'read');
    resolvedTarget = { id: entry.id, path: entry.path };
  }

  const result = await requestCommand('read', { ...config, fileId: resolvedTarget.id }, {
    defaultEndpoint: '/Project/${projectId}/doc/${fileId}/download',
    required: ['baseUrl', 'cookieHeader', 'projectId', 'fileId'],
  });

  if (resolvedTarget.path) {
    result.path = resolvedTarget.path;
  }
  result.fileId = resolvedTarget.id;
  return result;
}

async function editDocument(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader', 'projectId'], 'edit');
  if (!config.fileId && !config.filePath) {
    throw new Error('edit: missing required config: fileId or filePath');
  }

  const desiredText = readDesiredText(config);
  if (config.dryRun) {
    return {
      label: 'edit',
      mode: 'dry-run',
      path: config.filePath ? normalizeRemotePath(config.filePath) : '',
      fileId: config.fileId || '',
      desiredLength: desiredText.length,
      notes: [
        'Dry-run mode does not connect to the realtime service, so it cannot compute the exact OT diff.',
        'Disable dryRun and omit --send if you want to inspect the resolved doc target and planned OT update without applying it.',
      ],
    };
  }

  return await runSocketSession(config, async joinedProject => {
    const entries = flattenProjectTree(joinedProject.project);
    const target = resolveDocTarget(config, entries);
    const currentDoc = await joinDoc(joinedProject.socket, target.id);
    if (currentDoc.type !== 'sharejs-text-ot') {
      throw new Error(`edit: unsupported OT type ${currentDoc.type}. Only sharejs-text-ot is implemented in this CLI.`);
    }

    const currentText = docLinesToText(currentDoc.docLines);
    const op = buildTextReplaceOperations(currentText, desiredText);
    const plan = {
      fileId: target.id,
      path: target.path,
      previousVersion: currentDoc.version,
      deletedCharacters: sumDeletedCharacters(op),
      insertedCharacters: sumInsertedCharacters(op),
      operationCount: op.length,
    };

    if (op.length === 0) {
      return {
        label: 'edit',
        changed: false,
        ...plan,
        notes: ['Remote text already matches the requested content.'],
      };
    }

    if (!canSendMutation(config)) {
      return {
        label: 'edit',
        mode: 'dry-run',
        transport: 'socket.io-v0-xhr-polling',
        socketUrl: resolveSocketUrl(config).toString(),
        changed: true,
        update: redactAny({ v: currentDoc.version, op }, config),
        ...plan,
        notes: [
          'Pass --send or set sendMutations=true after reviewing the planned OT update.',
        ],
      };
    }

    await applyOtUpdate(joinedProject.socket, target.id, {
      v: currentDoc.version,
      op,
    });

    const refreshedDoc = await joinDoc(joinedProject.socket, target.id);
    return {
      label: 'edit',
      changed: true,
      ...plan,
      currentVersion: refreshedDoc.version,
      currentLength: docLinesToText(refreshedDoc.docLines).length,
      notes: [
        'The CLI reconnects to the doc after applyOtUpdate to confirm the document is still joinable and to recover the current version.',
      ],
    };
  });
}

async function createProjectEntity(label, config, { endpoint, type }) {
  assertRequired(config, ['baseUrl', 'cookieHeader', 'projectId'], label);
  const createSpec = deriveCreateSpec(config, type);

  if (!createSpec.name) {
    throw new Error(`${label}: missing required config: name or filePath`);
  }

  if (config.dryRun || !config.sendMutations) {
    const request = buildRequest({ ...config, csrfToken: config.csrfToken || '<resolved-at-runtime>' }, endpoint, 'POST', {
      body: JSON.stringify({
        parent_folder_id: `<resolved-from:${createSpec.parentPath}>`,
        name: createSpec.name,
      }, null, 2),
      contentType: 'application/json',
    });
    return {
      label,
      mode: 'dry-run',
      path: createSpec.path,
      parentPath: createSpec.parentPath,
      request: redactAny(request, config),
      notes: [
        'A realtime project snapshot is used at runtime to resolve the parent folder id from the requested path.',
        'Pass --send or set sendMutations=true after reviewing the request.',
      ],
    };
  }

  const snapshot = await loadProjectSnapshot(config);
  const parentEntry = resolveFolderTarget(createSpec.parentPath, snapshot.entries, label);
  const csrfToken = await ensureCsrfToken(config);
  const request = buildRequest({ ...config, csrfToken }, endpoint, 'POST', {
    body: JSON.stringify({
      parent_folder_id: parentEntry.id,
      name: createSpec.name,
    }),
    contentType: 'application/json',
  });
  const response = await executeRequest(request, config);
  const result = summarizeResponse(label, request, response, { ...config, csrfToken }, endpoint);
  const body = parseJson(response.body);
  if (body) {
    result.created = body;
  }
  result.path = createSpec.path;
  result.parentPath = createSpec.parentPath;
  return result;
}

async function renameProjectEntity(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader', 'projectId', 'filePath', 'name'], 'rename');
  const snapshot = canSendMutation(config) ? await loadProjectSnapshot(config) : null;
  const currentPath = normalizeRemotePath(config.filePath);
  const nextPath = joinRemotePath(dirnameRemotePath(currentPath), config.name);

  if (!canSendMutation(config)) {
    return {
      label: 'rename',
      mode: 'dry-run',
      path: currentPath,
      nextPath,
      notes: [
        'The source entity id will be resolved from the realtime project snapshot at runtime.',
        'Pass --send or set sendMutations=true after reviewing the rename target.',
      ],
    };
  }

  const entry = resolveEntryByPath(snapshot.entries, currentPath);
  if (entry.path === '/') {
    throw new Error('rename: cannot rename the root folder');
  }
  const csrfToken = await ensureCsrfToken(config);
  const endpoint = `/project/\${projectId}/${entityPathSegment(entry.type)}/${entry.id}/rename`;
  const request = buildRequest({ ...config, csrfToken }, endpoint, 'POST', {
    body: JSON.stringify({ name: config.name }),
    contentType: 'application/json',
  });
  const response = await executeRequest(request, config);
  const result = summarizeResponse('rename', request, response, { ...config, csrfToken }, endpoint);
  result.path = currentPath;
  result.nextPath = nextPath;
  result.entityType = entry.type;
  return result;
}

async function moveProjectEntity(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader', 'projectId', 'filePath', 'targetPath'], 'move');
  const currentPath = normalizeRemotePath(config.filePath);
  const destinationPath = normalizeRemotePath(config.targetPath);

  if (!canSendMutation(config)) {
    return {
      label: 'move',
      mode: 'dry-run',
      path: currentPath,
      targetPath: destinationPath,
      notes: [
        'The source entity id and destination folder id will be resolved from the realtime project snapshot at runtime.',
        'Pass --send or set sendMutations=true after reviewing the move target.',
      ],
    };
  }

  const snapshot = await loadProjectSnapshot(config);
  const entry = resolveEntryByPath(snapshot.entries, currentPath);
  if (entry.path === '/') {
    throw new Error('move: cannot move the root folder');
  }
  const folder = resolveFolderTarget(destinationPath, snapshot.entries, 'move');
  const csrfToken = await ensureCsrfToken(config);
  const endpoint = `/project/\${projectId}/${entityPathSegment(entry.type)}/${entry.id}/move`;
  const request = buildRequest({ ...config, csrfToken }, endpoint, 'POST', {
    body: JSON.stringify({ folder_id: folder.id }),
    contentType: 'application/json',
  });
  const response = await executeRequest(request, config);
  const result = summarizeResponse('move', request, response, { ...config, csrfToken }, endpoint);
  result.path = currentPath;
  result.targetPath = destinationPath;
  result.entityType = entry.type;
  return result;
}

async function deleteProjectEntity(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader', 'projectId', 'filePath'], 'delete');
  const currentPath = normalizeRemotePath(config.filePath);

  if (!canSendMutation(config)) {
    return {
      label: 'delete',
      mode: 'dry-run',
      path: currentPath,
      notes: [
        'The source entity id will be resolved from the realtime project snapshot at runtime.',
        'Pass --send or set sendMutations=true after reviewing the delete target.',
      ],
    };
  }

  const snapshot = await loadProjectSnapshot(config);
  const entry = resolveEntryByPath(snapshot.entries, currentPath);
  if (entry.path === '/') {
    throw new Error('delete: cannot delete the root folder');
  }
  const csrfToken = await ensureCsrfToken(config);
  const endpoint = `/project/\${projectId}/${entityPathSegment(entry.type)}/${entry.id}`;
  const request = buildRequest({ ...config, csrfToken }, endpoint, 'DELETE');
  const response = await executeRequest(request, config);
  const result = summarizeResponse('delete', request, response, { ...config, csrfToken }, endpoint);
  result.path = currentPath;
  result.entityType = entry.type;
  return result;
}

async function probeWrite(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader'], 'probe-write');

  const endpoint = config.endpoint || process.env.OVERLEAF_WRITE_ENDPOINT || '';
  const request = buildRequest(
    config,
    endpoint || '/socket-io-write-path-unconfirmed',
    config.method === 'GET' ? 'POST' : config.method,
    {
      body: config.body || JSON.stringify({
        projectId: config.projectId || '<project-id>',
        docId: config.fileId || '<doc-id>',
        update: {
          v: '<current-version>',
          op: ['<sharejs-or-history-ot-op>'],
          meta: {
            note: 'source-verified write path is socket.io applyOtUpdate after joinDoc',
          },
        },
      }, null, 2),
      contentType: 'application/json',
    },
  );

  const canSend = Boolean(endpoint && config.sendMutations);
  if (!canSend) {
    return {
      mode: 'dry-run',
      reason: 'source review indicates writes flow through the realtime socket applyOtUpdate path; no public HTTP write endpoint is confirmed yet',
      notes: [
        'The realtime service auto-joins a project from the socket.io handshake using the projectId query parameter and the signed session cookie.',
        'Document edits are then sent as applyOtUpdate socket events after joinDoc succeeds.',
        'Keep this command in dry-run mode until a live cookie-backed probe confirms the hosted-instance behavior you want to support.',
      ],
      request: redactAny(request, config),
    };
  }

  const response = await executeRequest(request, config);
  return summarizeResponse('probe-write', request, response, config, endpoint);
}

async function probeRefresh(config) {
  assertRequired(config, ['baseUrl', 'cookieHeader'], 'probe-refresh');

  const endpoint = config.endpoint || process.env.OVERLEAF_REFRESH_ENDPOINT || '';
  const requestConfig = endpoint
    ? config
    : {
        ...config,
        projectId: config.projectId || 'project-id',
        fileId: config.fileId || 'doc-id',
      };
  const request = buildRequest(requestConfig, endpoint || '/Project/${projectId}/doc/${fileId}/download', 'GET');
  if (!endpoint) {
    return {
      mode: 'dry-run',
      reason: 'public HTTP refresh can poll the doc download route, but authoritative version metadata currently comes from joinDoc and joinProject on the realtime service',
      notes: [
        'HTTP polling looks viable for coarse text refresh by re-downloading the doc body.',
        'Source review did not find a public HTTP route that exposes the same version metadata returned by realtime joinDoc.',
        'Treat polling-only refresh as provisional until a live probe confirms acceptable behavior and conflict detection.',
      ],
      request: redactAny(request, config),
    };
  }

  if (config.dryRun) {
    return { mode: 'dry-run', request: redactAny(request, config) };
  }

  const response = await executeRequest(request, config);
  return summarizeResponse('probe-refresh', request, response, config, endpoint);
}

function buildContractSummary(config) {
  return {
    label: 'contract',
    status: 'source-verified and locally implemented; live cookie-backed validation still required',
    mvpGate: 'editing commands are implemented, but the first live mutation should still happen in a throwaway project or doc',
    verifiedFromSource: {
      sessionCookie: 'default CE/web cookie name is overleaf.sid; hosted or legacy deployments may expose a different session cookie in the browser',
      validation: 'GET /user/projects',
      projectList: ['GET /user/projects', 'POST /api/project (csrf-protected)'],
      fileTree: [
        'GET /project/:Project_id/entities (public web route; paths/types only)',
        'socket.io auto-join with ?projectId=... returns the full rootFolder snapshot with ids',
      ],
      textRead: 'GET /Project/:Project_id/doc/:Doc_id/download',
      textWrite: 'socket.io applyOtUpdate after joinDoc; this CLI now exposes that path as the edit command',
      projectMutations: [
        'POST /project/:Project_id/doc',
        'POST /project/:Project_id/folder',
        'POST /project/:Project_id/:entity_type/:entity_id/rename',
        'POST /project/:Project_id/:entity_type/:entity_id/move',
        'DELETE /project/:Project_id/file/:entity_id',
        'DELETE /project/:Project_id/doc/:entity_id',
        'DELETE /project/:Project_id/folder/:entity_id',
      ],
      csrf: 'webRouter uses csurf; frontend sends X-Csrf-Token from the ol-csrfToken meta tag',
      refresh: 'joinDoc returns doc version and ops; the public doc download route does not expose equivalent version metadata',
    },
    remainingLiveChecks: [
      'Confirm the target hosted instance accepts the same validation, snapshot, read, and edit flows with a real imported session cookie.',
      'Confirm one safe write against a throwaway project or file.',
      'Decide whether MVP refresh can stay HTTP-polling-only or must use the realtime socket path.',
    ],
    notes: [
      'Use extract-csrf to fetch an authenticated HTML page and recover the current CSRF token.',
      'Use snapshot before path-based mutations when you need to see the resolved ids and normalized paths.',
      'Use request for one-off probes once a hosted-instance-specific route needs to be tested.',
      'Treat this summary as source-verified, not live-instance-validated, until you run the commands with a real session cookie.',
    ],
  };
}

async function loadProjectSnapshot(config) {
  return await runSocketSession(config, async joinedProject => {
    const entries = flattenProjectTree(joinedProject.project);
    return {
      project: joinedProject.project,
      entries,
      permissionsLevel: joinedProject.permissionsLevel,
      protocolVersion: joinedProject.protocolVersion,
      publicId: joinedProject.publicId,
    };
  });
}

function summarizeSnapshot(snapshot, config) {
  const result = {
    label: 'snapshot',
    projectId: snapshot.project._id,
    projectName: snapshot.project.name,
    rootDocId: snapshot.project.rootDoc_id,
    mainBibliographyDocId: snapshot.project.mainBibliographyDoc_id,
    permissionsLevel: snapshot.permissionsLevel,
    protocolVersion: snapshot.protocolVersion,
    transport: 'socket.io-v0-xhr-polling',
    socketUrl: resolveSocketUrl(config).toString(),
    entryCount: snapshot.entries.length,
    entries: snapshot.entries,
  };
  if (config.verbose || config.json) {
    result.project = snapshot.project;
  }
  return result;
}

async function ensureCsrfToken(config) {
  if (config.csrfToken) return config.csrfToken;

  const request = buildRequest(config, config.projectId ? '/Project/${projectId}' : '/project', 'GET', {
    accept: 'text/html,application/xhtml+xml',
  });
  const response = await executeRequest(request, config);
  const token = extractMetaContent(response.body, 'ol-csrfToken');
  if (!token) {
    throw new Error('Failed to extract ol-csrfToken from the authenticated HTML response.');
  }
  return token;
}

function resolveSocketUrl(config) {
  return new URL(config.socketUrl || '/socket.io', config.baseUrl);
}

function canSendMutation(config) {
  return Boolean(config.sendMutations) && !config.dryRun;
}

function flattenProjectTree(project) {
  const rootFolder = project?.rootFolder?.[0];
  if (!rootFolder) return [];

  const entries = [];
  visitFolder(rootFolder, '/', '');
  return entries;

  function visitFolder(folder, folderPath, parentId) {
    const normalizedFolderPath = normalizeRemotePath(folderPath);
    entries.push({
      id: String(folder._id || ''),
      type: 'folder',
      path: normalizedFolderPath,
      name: normalizedFolderPath === '/' ? 'rootFolder' : String(folder.name || ''),
      parentId: String(parentId || ''),
    });

    for (const childFolder of folder.folders || []) {
      visitFolder(childFolder, joinRemotePath(normalizedFolderPath, childFolder.name), folder._id);
    }
    for (const doc of folder.docs || []) {
      entries.push({
        id: String(doc._id || ''),
        type: 'doc',
        path: joinRemotePath(normalizedFolderPath, doc.name),
        name: String(doc.name || ''),
        parentId: String(folder._id || ''),
      });
    }
    for (const file of folder.fileRefs || []) {
      entries.push({
        id: String(file._id || ''),
        type: 'file',
        path: joinRemotePath(normalizedFolderPath, file.name),
        name: String(file.name || ''),
        parentId: String(folder._id || ''),
      });
    }
  }
}

function resolveDocTarget(config, entries) {
  if (config.filePath) {
    const entry = resolveEntryByPath(entries, config.filePath);
    assertEntryType(entry, ['doc'], 'edit');
    return entry;
  }

  const matchingEntry = entries.find(entry => entry.id === String(config.fileId));
  return {
    id: String(config.fileId),
    type: 'doc',
    path: matchingEntry?.path || '',
    name: matchingEntry?.name || '',
    parentId: matchingEntry?.parentId || '',
  };
}

function resolveEntryByPath(entries, remotePath) {
  const normalizedPath = normalizeRemotePath(remotePath);
  const entry = entries.find(candidate => candidate.path === normalizedPath);
  if (!entry) {
    throw new Error(`No project entry found at path: ${normalizedPath}`);
  }
  return entry;
}

function resolveFolderTarget(remotePath, entries, label) {
  const entry = resolveEntryByPath(entries, remotePath);
  assertEntryType(entry, ['folder'], label);
  return entry;
}

function assertEntryType(entry, allowedTypes, label) {
  if (!allowedTypes.includes(entry.type)) {
    throw new Error(`${label}: expected ${allowedTypes.join(' or ')} at ${entry.path}, found ${entry.type}`);
  }
}

function deriveCreateSpec(config, type) {
  if (config.filePath) {
    const path = normalizeRemotePath(config.filePath);
    return {
      path,
      parentPath: dirnameRemotePath(path),
      name: basenameRemotePath(path),
      type,
    };
  }

  const parentPath = normalizeRemotePath(config.parentPath || '/');
  const name = String(config.name || '');
  return {
    path: name ? joinRemotePath(parentPath, name) : parentPath,
    parentPath,
    name,
    type,
  };
}

function buildTextReplaceOperations(currentText, nextText) {
  if (currentText === nextText) return [];

  let prefixLength = 0;
  while (
    prefixLength < currentText.length &&
    prefixLength < nextText.length &&
    currentText[prefixLength] === nextText[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < currentText.length - prefixLength &&
    suffixLength < nextText.length - prefixLength &&
    currentText[currentText.length - 1 - suffixLength] === nextText[nextText.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const currentMiddle = currentText.slice(prefixLength, currentText.length - suffixLength);
  const nextMiddle = nextText.slice(prefixLength, nextText.length - suffixLength);
  const op = [];
  if (currentMiddle) {
    op.push({ p: prefixLength, d: currentMiddle });
  }
  if (nextMiddle) {
    op.push({ p: prefixLength, i: nextMiddle });
  }
  return op;
}

function docLinesToText(docLines) {
  if (!Array.isArray(docLines)) return '';
  return docLines.map(line => String(line)).join('\n');
}

function readDesiredText(config) {
  if (config.textFile) {
    return readFileSync(resolve(String(config.textFile)), 'utf8');
  }
  if (config.text !== undefined) {
    return String(config.text);
  }
  throw new Error('edit: missing required config: text or textFile');
}

function normalizeRemotePath(value) {
  let path = String(firstConfigured(value, '/') || '/').trim().replaceAll('\\', '/');
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/+/g, '/');
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path || '/';
}

function joinRemotePath(basePath, name) {
  return normalizeRemotePath(pathPosix.join(normalizeRemotePath(basePath), String(name || '')));
}

function dirnameRemotePath(remotePath) {
  const normalizedPath = normalizeRemotePath(remotePath);
  if (normalizedPath === '/') return '/';
  const dirname = pathPosix.dirname(normalizedPath);
  return normalizeRemotePath(dirname === '.' ? '/' : dirname);
}

function basenameRemotePath(remotePath) {
  const normalizedPath = normalizeRemotePath(remotePath);
  if (normalizedPath === '/') return '';
  return pathPosix.basename(normalizedPath);
}

function entityPathSegment(type) {
  switch (type) {
    case 'folder':
      return 'folder';
    case 'doc':
      return 'doc';
    case 'file':
      return 'file';
    default:
      throw new Error(`Unsupported entity type: ${type}`);
  }
}

function sumInsertedCharacters(op) {
  return op.reduce((sum, component) => sum + (component.i ? component.i.length : 0), 0);
}

function sumDeletedCharacters(op) {
  return op.reduce((sum, component) => sum + (component.d ? component.d.length : 0), 0);
}

function parseJson(text) {
  if (!text || !isJsonLike(text.trim())) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildRequest(config, endpoint, method, extra = {}) {
  const url = new URL(applyTemplate(endpoint, config), config.baseUrl);
  const headers = new Headers({
    Accept: extra.accept || 'application/json, text/plain, */*',
    Cookie: config.cookieHeader,
    ...config.headers,
    ...(extra.contentType ? { 'Content-Type': extra.contentType } : {}),
  });

  if (config.csrfToken) {
    headers.set('X-CSRF-Token', config.csrfToken);
  }

  const body = extra.body || config.body || undefined;
  if (body && method !== 'GET' && method !== 'HEAD') {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
  }

  return {
    method,
    url: url.toString(),
    headers: Object.fromEntries(headers.entries()),
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  };
}

async function executeRequest(request, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${config.timeoutMs}ms`)), config.timeoutMs);

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeResponse(label, request, response, config, endpointType = '') {
  const bodyPreview = previewBody(response.body, 1600);
  const parsedBody = parseJson(response.body);
  const redacted = redactAny({
    request,
    response: {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      bodyPreview,
    },
  }, config);

  const result = { label, endpointType, ...redacted };
  if (label === 'tree' && response.ok) {
    result.notes = [
      'The /project/:Project_id/entities route is useful for path/type inventory, but it does not expose the rootFolder ids required for editor-style joins.',
      'Use the realtime socket join for a full project snapshot once you are ready to validate socket auth with a live session cookie.',
    ];
  }
  if (label === 'read' && response.ok) {
    result.notes = [
      'This route downloads doc text over plain HTTP and is the simplest public read probe found in the upstream source.',
      'It does not expose the realtime version metadata returned by joinDoc.',
    ];
  }
  if (label === 'projects' && response.ok) {
    const projectList = extractProjectList(parsedBody);
    if (projectList.length > 0) {
      result.projects = projectList;
      result.projectCount = projectList.length;
    }
  }
  return result;
}

function extractProjectList(parsedBody) {
  const rawProjects = Array.isArray(parsedBody?.projects)
    ? parsedBody.projects
    : Array.isArray(parsedBody)
      ? parsedBody
      : [];

  return rawProjects
    .map(project => ({
      id: String(firstConfigured(project?.id, project?._id, project?.project_id) || ''),
      name: String(firstConfigured(project?.name, project?.projectName) || ''),
    }))
    .filter(project => project.id || project.name);
}

function printResult(command, result) {
  console.log(`# ${command}`);
  if (result.mode === 'dry-run') {
    console.log('Mode: dry-run');
  }
  if (result.reason) {
    console.log(`Reason: ${result.reason}`);
  }

  if (Array.isArray(result.notes) && result.notes.length > 0) {
    console.log('');
    console.log('Notes:');
    for (const note of result.notes) {
      console.log(`  - ${note}`);
    }
  }

  if (typeof result.found === 'boolean') {
    console.log('');
    console.log(`CSRF token found: ${result.found ? 'yes' : 'no'}`);
  }
  if (result.csrfToken) {
    console.log(`CSRF token: ${result.csrfToken}`);
  }

  if (result.request) {
    console.log('');
    console.log('Request:');
    console.log(`  ${result.request.method} ${result.request.url}`);
    printObject(result.request.headers, '  ');
    if (result.request.body) {
      console.log('  body:');
      printMultiline(result.request.body, '    ');
    }
  }

  if (result.response) {
    console.log('');
    console.log('Response:');
    console.log(`  ${result.response.status} ${result.response.statusText}`);
    printObject(result.response.headers, '  ');
    console.log('  body preview:');
    printMultiline(result.response.bodyPreview || '', '    ');
  }

  if (Array.isArray(result.projects) && result.projects.length > 0) {
    console.log('');
    console.log('Projects:');
    for (const project of result.projects) {
      const isSelected = result.selectedProjectId && String(result.selectedProjectId) === String(project.id);
      const prefix = isSelected ? '* ' : '  ';
      console.log(`${prefix}${project.id}  ${project.name || '(unnamed)'}`);
    }
  }

  printExtraFields(result);
}

function printObject(value, indent) {
  for (const [key, raw] of Object.entries(value || {})) {
    console.log(`${indent}${key}: ${formatScalar(raw)}`);
  }
}

function printMultiline(value, indent) {
  const lines = String(value).split('\n');
  for (const line of lines) {
    console.log(`${indent}${line}`);
  }
}

function formatScalar(value) {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function previewBody(body, limit) {
  if (!body) return '';
  const text = body.trim();
  if (!text) return '';
  if (isJsonLike(text)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2).slice(0, limit);
    } catch {
      return text.slice(0, limit);
    }
  }
  return text.slice(0, limit);
}

function isJsonLike(text) {
  const first = text[0];
  return first === '{' || first === '[';
}

function redactAny(value, config) {
  const replacements = new Map();
  for (const key of ['cookieHeader', 'csrfToken']) {
    const raw = config?.[key];
    if (raw) replacements.set(raw, `<redacted:${key}>`);
  }

  return redactStructured(value, replacements);
}

function redactStructured(value, replacements) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let result = value;
    for (const [needle, replacement] of replacements.entries()) {
      if (needle) result = result.split(needle).join(replacement);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactStructured(entry, replacements));
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        output[key] = '<redacted>';
        continue;
      }
      output[key] = redactStructured(entry, replacements);
    }
    return output;
  }
  return value;
}

function parseArgs(argv) {
  const options = {};
  const extraArgs = [];
  let command = '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!command && !arg.startsWith('-')) {
      command = arg;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg.startsWith('--')) {
      const [flag, inlineValue] = arg.split('=', 2);
      const key = flag.slice(2);
      switch (key) {
        case 'config': options.config = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'profile': options.profile = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'base-url': options.baseUrl = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'cookie': options.cookie = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'cookie-stdin': options.cookieStdin = true; break;
        case 'csrf': options.csrf = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'project': options.project = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'project-id': options.projectId = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'file-id': options.fileId = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'doc-id': options.docId = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'file-path': options.filePath = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'path': options.filePath = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'socket-url': options.socketUrl = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'name': options.name = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'parent-path': options.parentPath = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'target-path': options.targetPath = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'text': options.text = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'text-file': options.textFile = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'endpoint': options.endpoint = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'method': options.method = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'timeout-ms': options.timeoutMs = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        case 'json': options.json = true; break;
        case 'verbose': options.verbose = true; break;
        case 'dry-run': options.dryRun = true; break;
        case 'send': options.send = true; break;
        case 'header': {
          options.header ??= [];
          options.header.push(readArgValue(argv, i, inlineValue, key));
          if (inlineValue === undefined) i += 1;
          break;
        }
        case 'body': options.body = readArgValue(argv, i, inlineValue, key); if (inlineValue === undefined) i += 1; break;
        default:
          extraArgs.push(arg);
      }
      continue;
    }

    extraArgs.push(arg);
  }

  return { command, options, extraArgs };
}

function parseHeaders(headerValues, extraHeaderValues, settingsHeaders) {
  const headers = {};
  if (isPlainObject(settingsHeaders)) {
    for (const [key, value] of Object.entries(settingsHeaders)) {
      if (firstConfigured(key) && firstConfigured(value)) {
        headers[key] = String(value);
      }
    }
  }
  const values = [];
  if (Array.isArray(headerValues)) values.push(...headerValues);
  if (typeof extraHeaderValues === 'string' && extraHeaderValues.trim()) values.push(...extraHeaderValues.split(/\r?\n+/));
  for (const value of values) {
    const index = value.indexOf('=');
    const colon = value.indexOf(':');
    const splitAt = index > -1 && (colon === -1 || index < colon) ? index : colon;
    if (splitAt === -1) continue;
    const key = value.slice(0, splitAt).trim();
    const headerValue = value.slice(splitAt + 1).trim();
    if (key) headers[key] = headerValue;
  }
  return headers;
}

function assertRequired(config, required, label) {
  const missing = [];
  for (const key of required) {
    if (!config[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(`${label}: missing required config: ${missing.join(', ')}`);
  }
}

function inferMethod(command) {
  switch (command) {
    case 'add-doc':
    case 'add-folder':
    case 'rename':
    case 'move':
    case 'probe-write':
      return 'POST';
    case 'delete':
      return 'DELETE';
    default:
      return 'GET';
  }
}

function applyTemplate(template, config) {
  return template
    .replaceAll('${projectId}', encodeURIComponent(config.projectId || ''))
    .replaceAll('${fileId}', encodeURIComponent(config.fileId || ''))
    .replaceAll('${filePath}', encodePath(config.filePath || ''))
    .replaceAll('${baseUrl}', config.baseUrl || '');
}

function commandToEnvKey(command) {
  return command.replace(/-/g, '_').toUpperCase();
}

function commandSpecificEndpointKey(command) {
  switch (command) {
    case 'probe-write':
      return 'OVERLEAF_WRITE_ENDPOINT';
    case 'probe-refresh':
      return 'OVERLEAF_REFRESH_ENDPOINT';
    default:
      return '';
  }
}

function numberFrom(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function firstConfigured(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value === '') continue;
    return value;
  }
  return undefined;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return false;
}

function readArgValue(argv, index, inlineValue, key) {
  if (inlineValue !== undefined) {
    return inlineValue;
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for --${key}`);
  }

  return value;
}

function encodePath(value) {
  return String(value)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase();
  return SECRET_KEYS.has(normalized) || normalized.includes('cookie') || normalized.includes('csrf') || normalized === 'authorization';
}

function extractMetaContent(html, name) {
  if (!html) return '';
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<meta[^>]*name=["']${escapedName}["'][^>]*content=["']([^"']*)["']`, 'i');
  const match = html.match(pattern);
  return match?.[1] || '';
}

function printExtraFields(result) {
  const handledKeys = new Set(['label', 'mode', 'reason', 'notes', 'found', 'csrfToken', 'request', 'response', 'endpointType', 'projects']);
  for (const [key, value] of Object.entries(result)) {
    if (handledKeys.has(key) || value === undefined || value === null || value === '') {
      continue;
    }

    console.log('');
    console.log(`${formatSectionLabel(key)}:`);
    if (Array.isArray(value)) {
      for (const entry of value) {
        console.log(`  - ${formatScalar(entry)}`);
      }
      continue;
    }
    if (typeof value === 'object') {
      printObject(value, '  ');
      continue;
    }
    console.log(`  ${formatScalar(value)}`);
  }
}

function formatSectionLabel(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (match) => match.toUpperCase());
}

function printUsage() {
  console.log(`Usage:
  node tools/overleaf-discovery.mjs <command> [options]

Commands:
  setup           Create or validate a local gitignored settings file
  status          Show whether the active profile has stored Overleaf auth
  connect         Save and validate an Overleaf cookie for the active profile
  disconnect      Clear stored auth from the active profile
  validate        Validate an authenticated session using a lightweight request
  projects        Fetch the project list
  use-project     Save a default project in the local settings file
  tree            Fetch the public path/type project inventory for a project
  snapshot        Fetch the realtime project snapshot with entity ids
  read            Download a single text document from a project
  edit            Replace the full text of a document through applyOtUpdate
  add-doc         Create a new empty text document
  add-folder      Create a new folder
  rename          Rename a doc, file, or folder resolved by path
  move            Move a doc, file, or folder into another folder path
  delete          Delete a doc, file, or folder resolved by path
  extract-csrf    Fetch an authenticated HTML page and extract ol-csrfToken
  probe-write     Summarize the verified write path and prepare a safe probe
  probe-refresh   Summarize the verified refresh path and prepare a safe probe
  contract        Print the source-verified request contract summary
  request         Send an arbitrary request using the configured endpoint

Options:
  --config <path>       Read settings from a JSON file
  --profile <name>      Select a named profile from the settings file
  --base-url <url>      Overleaf base URL; defaults to https://www.overleaf.com
  --cookie <header>     Raw Cookie header value
  --cookie-stdin        Read the Cookie header from stdin
  --csrf <token>        CSRF token if required
  --project <ref>       Project name or id; use instead of --project-id when convenient
  --project-id <id>     Project id for tree/read probes
  --file-id <id>        Document id for read probes
  --doc-id <id>         Alias for --file-id
  --file-path <path>    Remote project path; used for read/edit/mutation commands
  --path <path>         Alias for --file-path
  --socket-url <url>    Optional realtime socket endpoint; defaults to <base-url>/socket.io
  --name <name>         New entity name for add-doc/add-folder/rename
  --parent-path <path>  Parent folder path for add-doc/add-folder
  --target-path <path>  Destination folder path for move
  --text <text>         Inline replacement text for edit
  --text-file <path>    Read replacement text for edit from a local file
  --endpoint <path>     Override the endpoint template
  --method <verb>       Override the HTTP verb
  --header k=v          Add an extra header; repeatable
  --body <text>         Override the request body
  --timeout-ms <n>      Timeout in milliseconds
  --dry-run             Print the request without sending it
  --send                Allow mutation commands to send live requests
  --json                Emit machine-readable JSON
  --verbose             Include extra diagnostic detail

Environment:
  OVERLEAF_BASE_URL
  OVERLEAF_CONFIG
  OVERLEAF_COOKIE_HEADER
  OVERLEAF_COOKIE_STDIN=1
  OVERLEAF_CSRF_TOKEN
  OVERLEAF_PROJECT
  OVERLEAF_PROFILE
  OVERLEAF_PROJECT_ID
  OVERLEAF_FILE_ID
  OVERLEAF_DOC_ID
  OVERLEAF_FILE_PATH
  OVERLEAF_SOCKET_URL
  OVERLEAF_NAME
  OVERLEAF_PARENT_PATH
  OVERLEAF_TARGET_PATH
  OVERLEAF_TEXT
  OVERLEAF_TEXT_FILE
  OVERLEAF_ENDPOINT
  OVERLEAF_VALIDATE_ENDPOINT
  OVERLEAF_PROJECTS_ENDPOINT
  OVERLEAF_TREE_ENDPOINT
  OVERLEAF_READ_ENDPOINT
  OVERLEAF_WRITE_ENDPOINT
  OVERLEAF_REFRESH_ENDPOINT
  OVERLEAF_DRY_RUN=1
  OVERLEAF_SEND_MUTATIONS=1
  OVERLEAF_JSON=1

Settings file auto-discovery:
  ./overleaf-agent.settings.json
  ./.overleaf-agent.json
`);
}
