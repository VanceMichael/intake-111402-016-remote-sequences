import {createHash} from 'node:crypto';
import {SourceError} from './transport.mjs';

/**
 * Constrained retrieval adapter for the authorized OPeNDAP gateway projection.
 *
 * The reader never builds a DAP expression, URL or query string from caller
 * input. It only emits the structured {descriptorRevision, projection,
 * selection} body described in contracts.md; the gateway owns wire encoding.
 */

const PLAN_KIND = 'subset-plan';
const PLAN_VERSION = 1;
const SELECTION_OPERATORS = new Set(['=', '==', '!=', '<', '<=', '>', '>=']);
const RANGE_KEYS = new Set(['start', 'stride', 'stop']);
const MAX_VARIABLES = 64;
const MAX_SELECTION = 64;
const MAX_NAME_LENGTH = 512;
const MAX_STRING_VALUE = 1024;

export class SubsetError extends Error {
  constructor(message, {code = 'subset-error', status = null, detail = null, cause = null} = {}) {
    super(message, cause ? {cause} : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export class ConsentError extends SubsetError {
  constructor(message, options = {}) {
    super(message, {code: 'not-authorized', status: 403, ...options});
  }
}

export class StalePlanError extends SubsetError {
  constructor(message, options = {}) {
    super(message, {code: 'stale-plan', status: 412, ...options});
    this.pending = options.pending ?? [];
    this.completed = options.completed ?? [];
    this.rows = options.rows ?? [];
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isScalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
// Revision tokens are compared exactly: a type or spelling change is a new
// descriptor, and an old plan must not be applied to it.
const sameRevision = (left, right) => left === right;
const product = values => values.reduce((total, value) => total * value, 1);
const rangeCount = range => range.stop < range.start ? 0 : Math.floor((range.stop - range.start) / range.stride) + 1;
const sameShape = (left, right) => Array.isArray(left) && Array.isArray(right) &&
  left.length === right.length && left.every((value, index) => value === right[index]);
const copyRanges = ranges => ranges.map(range => ({start: range.start, stride: range.stride, stop: range.stop}));
const hasControlCharacters = value => /[\u0000-\u001f\u007f]/.test(value);

function requestError(message, code = 'invalid-request') {
  return new SubsetError(message, {code, status: 400});
}

function descriptorError(message, code = 'invalid-descriptor') {
  return new SubsetError(message, {code, status: 502});
}

function planError(message) {
  return new SubsetError(message, {code: 'invalid-plan'});
}

function assertName(value, label, errorFor = requestError) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_LENGTH) {
    throw errorFor(`${label} must be a non-empty string`, 'invalid-name');
  }
  // Names are carried as JSON values, never interpolated into a URL, DAP
  // expression or shell command. Quotes, %, &, brackets, spaces and similar
  // characters are legal and remain exactly as the descriptor reported them.
  if (hasControlCharacters(value)) throw errorFor(`${label} contains control characters`, 'invalid-name');
  return value;
}

function assertIndex(value, label) {
  if (!Number.isInteger(value) || value < 0) throw requestError(`${label} must be a non-negative integer`, 'invalid-range');
  return value;
}

function assertStride(value, label) {
  if (!Number.isInteger(value) || value < 1) throw requestError(`${label} must be a positive integer`, 'invalid-range');
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/* ---------------------------------------------------------------- descriptor */

export function normalizeDescriptor(raw) {
  if (!isObject(raw)) throw descriptorError('descriptor must be an object');
  const revision = raw.revision;
  if (!((typeof revision === 'string' && revision.length > 0) ||
        (typeof revision === 'number' && Number.isFinite(revision)))) {
    throw descriptorError('descriptor revision required');
  }
  if (!Array.isArray(raw.variables)) throw descriptorError('descriptor variables required');
  if (!Array.isArray(raw.allowedNames)) throw descriptorError('descriptor allowedNames required');

  const seen = new Set();
  const variables = raw.variables.map((variable, index) => {
    if (!isObject(variable)) throw descriptorError(`variable ${index} must be an object`);
    const name = assertName(variable.name, `variable ${index} name`, descriptorError);
    if (seen.has(name)) throw descriptorError(`duplicate variable ${name}`);
    seen.add(name);
    if (typeof variable.type !== 'string' || variable.type.length === 0) {
      throw descriptorError(`variable ${name} type required`);
    }
    if (variable.dimensions !== undefined && !Array.isArray(variable.dimensions)) {
      throw descriptorError(`variable ${name} dimensions must be an array`);
    }
    const dimensionNames = new Set();
    const dimensions = (variable.dimensions ?? []).map((dimension, position) => {
      if (!isObject(dimension)) throw descriptorError(`variable ${name} dimension ${position} must be an object`);
      const dimensionName = assertName(dimension.name, `variable ${name} dimension ${position} name`, descriptorError);
      if (dimensionNames.has(dimensionName)) throw descriptorError(`duplicate dimension ${dimensionName} in ${name}`);
      dimensionNames.add(dimensionName);
      if (!Number.isInteger(dimension.size) || dimension.size < 0) {
        throw descriptorError(`variable ${name} dimension ${dimensionName} size must be a non-negative integer`);
      }
      return {name: dimensionName, size: dimension.size};
    });
    if (variable.attributes !== undefined && !isObject(variable.attributes)) {
      throw descriptorError(`variable ${name} attributes must be an object`);
    }
    return {name, type: variable.type, dimensions, attributes: {...(variable.attributes ?? {})}};
  });

  const allowedSeen = new Set();
  const allowedNames = raw.allowedNames.map((name, index) => {
    const checked = assertName(name, `allowedNames[${index}]`, descriptorError);
    if (allowedSeen.has(checked)) throw descriptorError(`duplicate allowed name ${checked}`);
    allowedSeen.add(checked);
    return checked;
  });
  return {revision, variables, allowedNames};
}

export async function readDescriptor(client) {
  return normalizeDescriptor(await client('/descriptor'));
}

/* --------------------------------------------------------------------- plan */

function normalizeRange(raw, label) {
  if (!isObject(raw)) throw requestError(`${label} must be an object`, 'invalid-range');
  const unknown = Object.keys(raw).filter(key => !RANGE_KEYS.has(key));
  if (unknown.length) throw requestError(`${label} has unsupported fields: ${unknown.join(', ')}`, 'invalid-range');
  const start = assertIndex(raw.start, `${label}.start`);
  const stride = raw.stride === undefined ? 1 : assertStride(raw.stride, `${label}.stride`);
  const stop = assertIndex(raw.stop, `${label}.stop`);
  if (start > stop) throw requestError(`${label}.start must not exceed stop`, 'invalid-range');
  const count = rangeCount({start, stride, stop});
  if (count < 1) throw requestError(`${label} selects no points`, 'invalid-range');
  return {start, stride, stop};
}

function resolveRanges(entry, variable, position) {
  const label = `variables[${position}]`;
  const allowed = new Set(['name', 'ranges', 'start', 'stride', 'stop']);
  const unknown = Object.keys(entry).filter(key => !allowed.has(key));
  if (unknown.length) throw requestError(`${label} has unsupported fields: ${unknown.join(', ')}`);

  let rawRanges;
  if (entry.ranges !== undefined) {
    if (Array.isArray(entry.ranges)) {
      if (entry.ranges.length !== variable.dimensions.length) {
        throw requestError(`${label}.ranges must align with ${variable.dimensions.length} dimensions`, 'invalid-range');
      }
      rawRanges = entry.ranges.map((range, index) => {
        if (!isObject(range)) throw requestError(`${label}.ranges[${index}] must be an object`, 'invalid-range');
        const {dimension, ...bounds} = range;
        if (dimension !== undefined && dimension !== variable.dimensions[index].name) {
          // A named dimension binds the interval to the descriptor revision; it
          // must not silently survive a shape change.
          throw requestError(`${label}.ranges[${index}] dimension does not match descriptor`, 'invalid-range');
        }
        return normalizeRange(bounds, `${label}.ranges[${index}]`);
      });
    } else if (isObject(entry.ranges)) {
      const expected = variable.dimensions.map(dimension => dimension.name);
      const keys = Object.keys(entry.ranges);
      if (keys.length !== expected.length || expected.some(name => !Object.hasOwn(entry.ranges, name))) {
        throw requestError(`${label}.ranges must name every dimension exactly once`, 'invalid-range');
      }
      rawRanges = expected.map(name => normalizeRange(entry.ranges[name], `${label}.ranges.${name}`));
    } else {
      throw requestError(`${label}.ranges must be an object or an array`, 'invalid-range');
    }
  } else if (Array.isArray(entry.start) || Array.isArray(entry.stop) || Array.isArray(entry.stride)) {
    const count = variable.dimensions.length;
    for (const key of ['start', 'stop']) {
      if (!Array.isArray(entry[key]) || entry[key].length !== count) {
        throw requestError(`${label}.${key} must list one bound per dimension`, 'invalid-range');
      }
    }
    if (entry.stride !== undefined && (!Array.isArray(entry.stride) || entry.stride.length !== count)) {
      throw requestError(`${label}.stride must list one step per dimension`, 'invalid-range');
    }
    rawRanges = variable.dimensions.map((_dimension, index) => normalizeRange({
      start: entry.start[index],
      stride: entry.stride?.[index],
      stop: entry.stop[index]
    }, `${label}[${index}]`));
  } else if (entry.start !== undefined || entry.stop !== undefined || entry.stride !== undefined) {
    if (variable.dimensions.length !== 1) {
      throw requestError(`${label} must use ranges or per-dimension arrays for a multi-dimensional variable`, 'invalid-range');
    }
    rawRanges = [normalizeRange({start: entry.start, stride: entry.stride, stop: entry.stop}, label)];
  } else if (variable.dimensions.length === 0) {
    rawRanges = [];
  } else {
    throw requestError(`${label}.ranges is required; claim only the requested interval`, 'invalid-range');
  }

  return rawRanges.map((range, index) => {
    const dimension = variable.dimensions[index];
    if (dimension.size === 0) throw requestError(`${label} selects an empty dimension`, 'invalid-range');
    if (range.stop >= dimension.size) {
      throw requestError(`${label} dimension ${dimension.name} stop must be below size ${dimension.size}`, 'invalid-range');
    }
    return range;
  });
}

function normalizeSelection(raw, allowedNames) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SELECTION) {
    throw requestError('selection must be a bounded array', 'invalid-selection');
  }
  return raw.map((item, index) => {
    if (!isObject(item)) throw requestError(`selection[${index}] must be an object`, 'invalid-selection');
    const unknown = Object.keys(item).filter(key => !['name', 'dimension', 'operator', 'value'].includes(key));
    if (unknown.length) throw requestError(`selection[${index}] has unsupported fields: ${unknown.join(', ')}`, 'invalid-selection');
    if (item.name !== undefined && item.dimension !== undefined && item.name !== item.dimension) {
      throw requestError(`selection[${index}] names disagree`, 'invalid-selection');
    }
    const name = item.dimension ?? item.name;
    if (!allowedNames.has(name)) {
      throw requestError(`selection[${index}] is outside the authorized variables`, 'invalid-selection');
    }
    if (!SELECTION_OPERATORS.has(item.operator)) {
      throw requestError(`selection[${index}] operator is not supported`, 'invalid-selection');
    }
    const {value} = item;
    const valid = (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' ||
      (typeof value === 'string' && value.length <= MAX_STRING_VALUE && !hasControlCharacters(value));
    if (!valid) throw requestError(`selection[${index}] value must be a finite scalar`, 'invalid-selection');
    return {name, operator: item.operator, value};
  });
}

function requestVariables(request) {
  if (!isObject(request)) throw requestError('claim request must be an object');
  const allowed = new Set(['variables', 'projection', 'selection']);
  const unknown = Object.keys(request).filter(key => !allowed.has(key));
  if (unknown.length) throw requestError(`claim request has unsupported fields: ${unknown.join(', ')}`);
  if (request.variables !== undefined && request.projection !== undefined) {
    throw requestError('claim request must not supply both variables and projection');
  }
  const variables = request.variables ?? request.projection;
  if (!Array.isArray(variables) || variables.length === 0 || variables.length > MAX_VARIABLES) {
    throw requestError('claim request needs a bounded variables array');
  }
  return variables;
}

export function planSubset(descriptor, request) {
  const catalog = normalizeDescriptor(descriptor);
  const requested = requestVariables(request);
  const seen = new Set();
  const variables = requested.map((entry, position) => {
    if (!isObject(entry)) throw requestError(`variables[${position}] must be an object`);
    const name = assertName(entry.name, `variables[${position}].name`);
    if (seen.has(name)) throw requestError(`variable ${name} requested more than once`);
    seen.add(name);
    const variable = catalog.variables.find(candidate => candidate.name === name);
    if (!variable || !catalog.allowedNames.includes(name)) {
      throw new ConsentError(`variable is not authorized: ${name}`, {detail: {name}});
    }
    const ranges = resolveRanges(entry, variable, position);
    return {
      name: variable.name,
      type: variable.type,
      dimensions: variable.dimensions.map(dimension => ({...dimension})),
      ranges: copyRanges(ranges),
      expectedShape: ranges.map(range => rangeCount(range))
    };
  });

  const allowedSelectionNames = new Set();
  for (const variable of variables) {
    allowedSelectionNames.add(variable.name);
    for (const dimension of variable.dimensions) allowedSelectionNames.add(dimension.name);
  }
  const selection = normalizeSelection(request.selection, allowedSelectionNames);
  const payload = {kind: PLAN_KIND, version: PLAN_VERSION, revision: catalog.revision, variables, selection};
  return deepFreeze({...payload, fingerprint: digest(payload)});
}

export function assertPlan(plan) {
  if (!isObject(plan) || plan.kind !== PLAN_KIND || plan.version !== PLAN_VERSION || typeof plan.fingerprint !== 'string') {
    throw planError('claim plan was not produced by planSubset');
  }
  const {fingerprint, ...payload} = plan;
  if (digest(payload) !== fingerprint) throw planError('claim plan fingerprint does not match its contents');
  if (!((typeof payload.revision === 'string' && payload.revision.length > 0) ||
        (typeof payload.revision === 'number' && Number.isFinite(payload.revision)))) {
    throw planError('claim plan revision required');
  }
  if (!Array.isArray(payload.variables) || payload.variables.length === 0 || payload.variables.length > MAX_VARIABLES) {
    throw planError('claim plan variables required');
  }
  const names = new Set();
  for (const variable of payload.variables) {
    if (!isObject(variable)) throw planError('claim plan variable must be an object');
    const name = assertName(variable.name, 'plan variable name', planError);
    if (names.has(name)) throw planError(`claim plan repeats ${name}`);
    names.add(name);
    if (typeof variable.type !== 'string' || !Array.isArray(variable.dimensions) ||
        !Array.isArray(variable.ranges) || !Array.isArray(variable.expectedShape)) {
      throw planError(`claim plan variable ${name} is incomplete`);
    }
    if (variable.dimensions.length !== variable.ranges.length ||
        variable.ranges.length !== variable.expectedShape.length) {
      throw planError(`claim plan variable ${name} is not aligned to dimensions`);
    }
    for (const dimension of variable.dimensions) {
      if (!isObject(dimension)) throw planError('claim plan dimension must be an object');
      assertName(dimension.name, 'plan dimension name', planError);
      if (!Number.isInteger(dimension.size) || dimension.size < 0) throw planError('claim plan dimension size invalid');
    }
    for (const [index, range] of variable.ranges.entries()) {
      if (!isObject(range)) throw planError('claim plan range must be an object');
      if (!Number.isInteger(range.start) || range.start < 0) throw planError('claim plan range start invalid');
      if (!Number.isInteger(range.stride) || range.stride < 1) throw planError('claim plan range stride invalid');
      if (!Number.isInteger(range.stop) || range.stop < 0) throw planError('claim plan range stop invalid');
      if (range.start > range.stop || range.stop >= variable.dimensions[index].size) {
        throw planError('claim plan range is out of bounds');
      }
      if (rangeCount(range) !== variable.expectedShape[index]) throw planError(`claim plan variable ${name} shape is inconsistent`);
    }
  }
  const allowedSelectionNames = new Set();
  for (const variable of payload.variables) {
    allowedSelectionNames.add(variable.name);
    for (const dimension of variable.dimensions) allowedSelectionNames.add(dimension.name);
  }
  try {
    const selection = normalizeSelection(payload.selection, allowedSelectionNames);
    if (selection.length !== (payload.selection ?? []).length) throw planError('claim plan selection invalid');
  } catch (error) {
    if (error instanceof SubsetError && error.code === 'invalid-plan') throw error;
    throw planError(`claim plan selection invalid: ${error.message}`);
  }
  return plan;
}

function projectionFor(variable) {
  // Structured constraint only. Scalar bounds for one dimension, one bound per
  // dimension for grids. No DAP text and no URL is constructed here.
  if (variable.ranges.length === 0) return {name: variable.name};
  if (variable.ranges.length === 1) {
    const [range] = variable.ranges;
    return {name: variable.name, start: range.start, stride: range.stride, stop: range.stop};
  }
  return {
    name: variable.name,
    start: variable.ranges.map(range => range.start),
    stride: variable.ranges.map(range => range.stride),
    stop: variable.ranges.map(range => range.stop)
  };
}

function selectionFor(plan, variable) {
  return (plan.selection ?? []).filter(item =>
    item.name === variable.name || variable.dimensions.some(dimension => dimension.name === item.name));
}

/* --------------------------------------------------------------- responses */

function pendingRanges(variable, counts, reason) {
  // Ranges are listed in dimension order. Everything before the first dimension
  // that fell short is settled; that dimension resumes after the received
  // prefix; later dimensions stay whole because the cut position is unknown.
  const ranges = [];
  let settledPrefix = true;
  for (let index = 0; index < variable.ranges.length; index++) {
    const range = variable.ranges[index];
    const dimension = variable.dimensions[index]?.name ?? null;
    const received = counts?.[index] ?? 0;
    if (settledPrefix && counts !== null && received >= variable.expectedShape[index]) continue;
    if (settledPrefix && counts !== null) {
      settledPrefix = false;
      ranges.push({dimension, start: range.start + range.stride * Math.max(0, received), stride: range.stride, stop: range.stop});
    } else {
      ranges.push({dimension, start: range.start, stride: range.stride, stop: range.stop});
    }
  }
  if (ranges.length === 0 && reason !== null) {
    // The source explicitly reported a problem even though the expected number of
    // values arrived; do not present the interval as fully settled.
    return copyRanges(variable.ranges).map((range, index) => ({
      dimension: variable.dimensions[index]?.name ?? null,
      ...range
    }));
  }
  return ranges;
}

function pendingEntry(variable, reason, counts) {
  return {
    name: variable.name,
    reason,
    ranges: pendingRanges(variable, counts, reason),
    received: counts === null ? null : [...counts],
    expected: [...variable.expectedShape]
  };
}

function nestedShape(value) {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [0];
  const children = value.map(nestedShape);
  if (children.every(shape => shape === null)) return [value.length];
  if (children.some(shape => shape === null)) return null;
  const first = stableStringify(children[0]);
  if (!children.every(shape => stableStringify(shape) === first)) return null;
  return [value.length, ...children[0]];
}

function hasOnlyScalarLeaves(value) {
  if (Array.isArray(value)) return value.every(hasOnlyScalarLeaves);
  return isScalar(value);
}

function extractValues(data) {
  if (Array.isArray(data)) return {values: data, maps: {}};
  if (!isObject(data)) return null;
  const maps = isObject(data.maps) ? data.maps : {};
  for (const key of ['array', 'values', 'rows', 'sequence', 'items', 'records']) {
    if (Array.isArray(data[key])) return {values: data[key], maps};
  }
  for (const key of ['sequence', 'rows']) {
    if (isObject(data[key])) {
      const nested = extractValues(data[key]);
      if (nested) return {values: nested.values, maps: {...maps, ...nested.maps}};
    }
  }
  return null;
}

function descriptorEntry(response, variable) {
  const entries = Array.isArray(response.descriptor) ? response.descriptor : [response.descriptor];
  const matches = entries.filter(entry => isObject(entry) && entry.name === variable.name);
  if (matches.length !== 1) return null;
  const [entry] = matches;
  if (entry.shape !== undefined && (!Array.isArray(entry.shape) ||
      entry.shape.some(value => !Number.isInteger(value) || value < 0))) {
    return null;
  }
  return {name: entry.name, shape: entry.shape === undefined ? null : [...entry.shape]};
}

function analyzeResponse(plan, variable, response) {
  const expectedShape = variable.expectedShape;
  const expectedCount = product(expectedShape);
  const isGrid = /grid/i.test(variable.type);
  const isSequence = /sequence/i.test(variable.type);
  const row = {
    id: `subset:${plan.revision}:${plan.fingerprint}:${variable.name}`,
    kind: 'subset',
    revision: plan.revision,
    planFingerprint: plan.fingerprint,
    name: variable.name,
    type: variable.type,
    dimensions: variable.dimensions.map(dimension => ({...dimension})),
    requested: {
      ranges: copyRanges(variable.ranges).map((range, index) => ({...range, count: expectedShape[index]})),
      shape: [...expectedShape],
      selection: selectionFor(plan, variable)
    },
    descriptor: null,
    shape: null,
    declaredShape: null,
    receivedShape: null,
    maps: {},
    data: null,
    receivedCount: 0,
    expectedCount,
    sequenceEnd: null,
    truncated: null,
    complete: false,
    pendingRanges: [],
    problem: null
  };

  const finish = (problem, counts = null) => {
    const pending = pendingEntry(variable, problem, counts);
    row.problem = problem;
    row.pendingRanges = pending.ranges;
    row.complete = false;
    return {row, complete: false, pending};
  };

  if (!isObject(response)) return finish('response-structure');
  if (!sameRevision(response.revision, plan.revision)) {
    throw new StalePlanError('source answered with a different descriptor revision', {
      pending: [pendingEntry(variable, 'stale-plan', null)],
      completed: []
    });
  }
  row.truncated = typeof response.truncated === 'boolean' ? response.truncated : null;
  row.sequenceEnd = typeof response.sequenceEnd === 'boolean' ? response.sequenceEnd : null;
  if (row.truncated === null || row.sequenceEnd === null) return finish('missing-completion-flags');

  const descriptor = descriptorEntry(response, variable);
  if (!descriptor) return finish('response-structure');
  row.descriptor = descriptor;
  row.declaredShape = descriptor.shape;
  row.shape = descriptor.shape;

  const extracted = extractValues(response.data);
  if (!extracted) return finish('response-structure');
  row.data = extracted.values;
  row.receivedCount = extracted.values.length;

  // Coordinates and any other projected fields are kept only for the dimensions
  // that were actually authorized; unrelated response fields are ignored.
  const requestedDimensions = new Set(variable.dimensions.map(dimension => dimension.name));
  for (const [name, map] of Object.entries(extracted.maps)) {
    if (!requestedDimensions.has(name)) continue;
    if (!Array.isArray(map)) return finish('response-structure');
    row.maps[name] = [...map];
  }

  let counts = null;
  if (isGrid) {
    const result = analyzeGrid(row, variable, descriptor, extracted, expectedShape, expectedCount);
    if (result.problem) return finish(result.problem, result.counts);
    counts = result.counts;
  } else if (isSequence) {
    const result = analyzeSequence(row, descriptor, extracted, expectedShape, expectedCount);
    if (result.problem) return finish(result.problem, result.counts);
    counts = result.counts;
  } else {
    const result = analyzeArray(row, descriptor, extracted, expectedShape, expectedCount);
    if (result.problem) return finish(result.problem, result.counts);
    counts = result.counts;
  }

  if (row.truncated) return finish('truncated', counts);
  if (!row.sequenceEnd) return finish('sequence-not-ended', counts);
  const complete = expectedShape.length === 0
    ? !row.truncated && row.sequenceEnd
    : counts !== null && counts.every((count, index) => count === expectedShape[index]) &&
      row.receivedCount === expectedCount;
  if (!complete) return finish('incomplete-range', counts);

  row.complete = true;
  return {row, complete: true, pending: null};
}

function analyzeGrid(row, variable, descriptor, extracted, expectedShape, expectedCount) {
  const values = extracted.values;
  if (!hasOnlyScalarLeaves(values)) return {problem: 'response-structure', counts: null};
  if (descriptor.shape === null || descriptor.shape.length !== expectedShape.length) {
    return {problem: 'response-shape', counts: null};
  }
  // The declared shape may report a truncated prefix, but it can never claim
  // more than the plan asked for and it cannot change the rank.
  if (descriptor.shape.some((size, index) => size > expectedShape[index])) {
    return {problem: 'response-shape', counts: null};
  }
  if (!row.truncated && !sameShape(descriptor.shape, expectedShape)) {
    return {problem: 'response-shape', counts: null};
  }

  const nested = values.some(value => Array.isArray(value));
  let counts = null;
  if (nested) {
    if (values.length === 0) {
      // No shape can be read from an empty payload. If the source blamed
      // truncation, keep the interval pending rather than inventing a shape.
      if (!row.truncated) return {problem: row.sequenceEnd ? 'short-array' : 'response-structure', counts: null};
    } else {
      const shape = nestedShape(values);
      if (!shape || shape.length !== expectedShape.length || shape.some((size, index) => size > expectedShape[index])) {
        return {problem: 'response-shape', counts: null};
      }
      if (!row.truncated && !sameShape(shape, expectedShape)) return {problem: 'response-shape', counts: null};
      counts = [...shape];
      row.receivedShape = [...shape];
      row.receivedCount = product(shape);
    }
  } else {
    if (!values.every(isScalar)) return {problem: 'response-structure', counts: null};
    if (values.length > expectedCount) return {problem: 'response-shape', counts: null};
    if (values.length === expectedCount) {
      counts = [...expectedShape];
      row.receivedShape = [...expectedShape];
      row.receivedCount = expectedCount;
    } else if (row.truncated) {
      // A flat payload identifies a prefix only in one dimension.
      if (expectedShape.length === 1) {
        counts = [values.length];
        row.receivedShape = [values.length];
      }
    } else if (row.sequenceEnd) {
      // sequenceEnd with a short array is a structural contradiction, not a
      // partial read: there is no honest prefix interpretation for it.
      return {problem: 'short-array', counts: null};
    }
  }

  for (let index = 0; index < variable.dimensions.length; index++) {
    const dimension = variable.dimensions[index];
    const map = row.maps[dimension.name];
    if (map === undefined) {
      if (!row.truncated) return {problem: 'grid-map-missing', counts};
      continue;
    }
    if (map.length > expectedShape[index]) return {problem: 'grid-map-shape', counts};
    // A map is the coordinate axis for the delivered values; it must not claim
    // a different extent than the array along that dimension.
    if (counts !== null) {
      if (map.length !== counts[index]) return {problem: 'grid-map-shape', counts};
    }
    if (!row.truncated && map.length !== expectedShape[index]) return {problem: 'grid-map-shape', counts};
  }
  return {counts};
}

function analyzeSequence(row, descriptor, extracted, expectedShape, expectedCount) {
  const values = extracted.values;
  row.receivedShape = nestedShape(values);
  if (descriptor.shape !== null && expectedShape.length > 0) {
    if (descriptor.shape.length !== expectedShape.length ||
        descriptor.shape.some((size, index) => size > expectedShape[index])) {
      return {problem: 'response-shape', counts: null};
    }
    if (!row.truncated && !sameShape(descriptor.shape, expectedShape)) return {problem: 'response-shape', counts: null};
  }
  if (expectedShape.length === 0) return {counts: null};
  if (values.length > expectedCount) return {problem: 'response-shape', counts: null};
  if (values.length === expectedCount) {
    if (expectedShape.length === 1) row.receivedShape = [values.length];
    return {counts: [...expectedShape]};
  }
  if (row.truncated) {
    if (expectedShape.length === 1 && nestedShape(values)?.length === 1) {
      return {counts: [values.length]};
    }
    return {counts: null};
  }
  if (row.sequenceEnd) return {problem: 'short-array', counts: null};
  return {counts: null};
}

function analyzeArray(row, descriptor, extracted, expectedShape, expectedCount) {
  const values = extracted.values;
  if (descriptor.shape !== null && expectedShape.length > 0) {
    if (descriptor.shape.length !== expectedShape.length ||
        descriptor.shape.some((size, index) => size > expectedShape[index])) {
      return {problem: 'response-shape', counts: null};
    }
    if (!row.truncated && !sameShape(descriptor.shape, expectedShape)) return {problem: 'response-shape', counts: null};
  }
  if (expectedShape.length === 0) return {counts: null};
  const nested = values.some(value => Array.isArray(value));
  if (nested) {
    const shape = nestedShape(values);
    if (!shape || shape.length !== expectedShape.length || shape.some((size, index) => size > expectedShape[index])) {
      return {problem: 'response-shape', counts: null};
    }
    if (!row.truncated && !sameShape(shape, expectedShape)) return {problem: 'response-shape', counts: null};
    row.receivedShape = [...shape];
    row.receivedCount = product(shape);
    return {counts: [...shape]};
  }
  if (!values.every(isScalar)) return {problem: 'response-structure', counts: null};
  if (values.length > expectedCount) return {problem: 'response-shape', counts: null};
  if (values.length === expectedCount) {
    row.receivedShape = [...expectedShape];
    row.receivedCount = expectedCount;
    return {counts: [...expectedShape]};
  }
  if (row.truncated && expectedShape.length === 1) {
    row.receivedShape = [values.length];
    return {counts: [values.length]};
  }
  if (row.sequenceEnd) return {problem: 'short-array', counts: null};
  return {counts: null};
}

/* -------------------------------------------------------------------- claim */

function staleException(message, plan, {completed = [], rows = []} = {}) {
  const resolved = new Set(completed);
  return new StalePlanError(message, {
    pending: plan.variables
      .filter(variable => !resolved.has(variable.name))
      .map(variable => pendingEntry(variable, 'stale-plan', null)),
    completed,
    rows
  });
}

function assertDescriptorStillFits(descriptor, plan) {
  if (!sameRevision(descriptor.revision, plan.revision)) {
    throw staleException('descriptor revision changed; the plan must be rebuilt', plan);
  }
  for (const variable of plan.variables) {
    const current = descriptor.variables.find(candidate => candidate.name === variable.name);
    if (!current) throw staleException(`variable disappeared from descriptor: ${variable.name}`, plan);
    if (!descriptor.allowedNames.includes(variable.name)) {
      throw new ConsentError(`variable is no longer authorized: ${variable.name}`, {detail: {name: variable.name}});
    }
    if (current.type !== variable.type) {
      throw staleException(`descriptor type changed for ${variable.name}; the plan must be rebuilt`, plan);
    }
    if (current.dimensions.length !== variable.dimensions.length ||
        current.dimensions.some((dimension, index) =>
          dimension.name !== variable.dimensions[index].name || dimension.size !== variable.dimensions[index].size)) {
      throw staleException(`descriptor shape changed for ${variable.name}; the plan must be rebuilt`, plan);
    }
    if (variable.ranges.some((range, index) => range.stop >= variable.dimensions[index].size)) {
      throw staleException(`plan range is no longer inside ${variable.name}`, plan);
    }
  }
}

export async function claimSubset(client, plan) {
  assertPlan(plan);
  // A plan is only valid for the descriptor revision it was built from. Read the
  // live descriptor first and refuse the whole plan on any mismatch, so a stale
  // slice expression cannot silently select different dimensions.
  const descriptor = await readDescriptor(client);
  assertDescriptorStillFits(descriptor, plan);

  const rows = [];
  const pending = [];
  const completed = [];
  for (const variable of plan.variables) {
    let response;
    try {
      response = await client('/subset', {
        method: 'POST',
        body: {
          descriptorRevision: plan.revision,
          projection: [projectionFor(variable)],
          selection: selectionFor(plan, variable)
        }
      });
    } catch (error) {
      if (error instanceof SourceError && error.status === 412) {
        throw staleException(error.message, plan, {completed, rows});
      }
      if (error instanceof SourceError && error.status === 403) {
        throw new ConsentError(error.message, {status: error.status, detail: error.data ?? null, cause: error});
      }
      throw error;
    }
    let result;
    try {
      result = analyzeResponse(plan, variable, response);
    } catch (error) {
      if (error instanceof StalePlanError) {
        // The variable being processed did not produce a usable row; it stays
        // pending along with every not-yet-completed variable.
        const resolved = new Set(completed);
        throw new StalePlanError(error.message, {
          status: error.status,
          detail: error.detail,
          cause: error,
          pending: plan.variables
            .filter(candidate => !resolved.has(candidate.name))
            .map(candidate => pendingEntry(candidate, 'stale-plan', null)),
          completed,
          rows
        });
      }
      throw error;
    }
    rows.push(result.row);
    if (result.complete) completed.push(variable.name);
    else pending.push(result.pending);
  }

  return {
    revision: plan.revision,
    planFingerprint: plan.fingerprint,
    complete: pending.length === 0,
    completed,
    rows,
    pending
  };
}

/**
 * Rows are the archived originals, as with collect(client). The aggregate
 * status is attached non-enumerably so JSON and array comparisons still see
 * only the original rows.
 */
function attachClaim(rows, claim) {
  Object.defineProperties(rows, {
    pending: {value: claim.pending, enumerable: false},
    completed: {value: claim.completed, enumerable: false},
    complete: {value: claim.complete, enumerable: false},
    revision: {value: claim.revision, enumerable: false},
    planFingerprint: {value: claim.planFingerprint, enumerable: false},
    claim: {value: claim, enumerable: false}
  });
  return rows;
}

export const claim = claimSubset;

export async function collectSubset(client, requestOrPlan) {
  if (isObject(requestOrPlan) && requestOrPlan.kind === PLAN_KIND) return claimSubset(client, requestOrPlan);
  const descriptor = await readDescriptor(client);
  return claimSubset(client, planSubset(descriptor, requestOrPlan));
}

export async function collect(client, request = null) {
  const descriptor = await readDescriptor(client);
  if (request === null) {
    return descriptor.variables.map(variable => ({id:`${descriptor.revision}:${variable.name}`,name:variable.name,
      type:variable.type,dimensions:variable.dimensions,attributes:variable.attributes}));
  }
  const plan = isObject(request) && request.kind === PLAN_KIND ? request : planSubset(descriptor, request);
  const claimResult = await claimSubset(client, plan);
  return attachClaim(claimResult.rows, claimResult);
}
