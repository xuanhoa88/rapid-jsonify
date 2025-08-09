const fs = require('fs');
const path = require('path');
const { withMutex } = require('rapid-mutex');
const { Transform, pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

const MAX_CACHE_SIZE = 1000;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const patternCache = new Map();
const cacheTimestamps = new Map();

/**
 * Destroy a stream and remove all listeners if possible (cleanup helper).
 * @param {object} stream
 */
const cleanupStream = stream => {
  try {
    if (stream && !stream.destroyed && typeof stream.destroy === 'function') {
      stream.destroy();
    }
    if (stream && typeof stream.removeAllListeners === 'function') {
      stream.removeAllListeners();
    }
  } catch (err) {
    console.error('Error during stream cleanup:', err);
  }
};

/**
 * Custom JSON.parse that preserves large integers as strings (using a reviver).
 * @param {string} text
 * @returns {any}
 */
const parseJSON = text =>
  JSON.parse(text, (_key, value) => {
    if (typeof value === 'string' && /^-?\d{16,}$/.test(value)) return BigInt(value);
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return value.toString();
    return value;
  });

/**
 * Custom JSON.stringify that serializes BigInt and large number strings as strings.
 * Wraps optional replacer.
 * @param {any} value
 * @param {function|Array} [replacer]
 * @param {number|string} [space]
 * @returns {string}
 */
const stringifyJSON = (value, replacer, space) => {
  const safeReplacer = (key, val) => {
    if (typeof val === 'bigint') return val.toString();
    if (typeof val === 'string' && /^-?\d{16,}$/.test(val)) return val;
    if (typeof val === 'number' && !Number.isSafeInteger(val)) return val.toString();
    if (typeof replacer === 'function') return replacer(key, val);
    if (Array.isArray(replacer)) return replacer.includes(key) ? val : undefined;
    return val;
  };
  return JSON.stringify(value, safeReplacer, space);
};

/**
 * Check if a filesystem entry exists at the given path.
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
/**
 * Check if a filesystem entry exists at the given path and return its stat if exists.
 * @param {string} targetPath
 * @returns {Promise<false|fs.Stats>}
 */
async function getPathInfo(targetPath) {
  try {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      throw new TypeError('Invalid path');
    }

    const stat = await fs.promises.lstat(path.resolve(targetPath));
    return stat;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Recursively create a directory if it does not exist.
 * @param {string} directoryPath
 * @returns {Promise<boolean>}
 */
const createDirectory = async directoryPath => {
  if (typeof directoryPath !== 'string' || !directoryPath.trim()) {
    throw new TypeError('Invalid directory path');
  }
  try {
    await fs.promises.mkdir(path.resolve(directoryPath), { recursive: true });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return true;
    throw err;
  }
};

/**
 * Pattern matching with cache and expiration cleanup.
 * @param {any} targetPattern
 * @param {any} testValue
 * @returns {boolean}
 */
const isMatchedPattern = (targetPattern, testValue) => {
  const cacheKey = `${targetPattern}-${testValue}`;
  const now = Date.now();

  // Remove expired cache entries
  for (const [key, timestamp] of cacheTimestamps.entries()) {
    if (now - timestamp > CACHE_TTL) {
      patternCache.delete(key);
      cacheTimestamps.delete(key);
    }
  }

  // Cleanup cache if too large
  if (patternCache.size > MAX_CACHE_SIZE) {
    const keysToDelete = Array.from(patternCache.keys()).slice(
      0,
      patternCache.size - MAX_CACHE_SIZE
    );
    for (const key of keysToDelete) {
      patternCache.delete(key);
      cacheTimestamps.delete(key);
    }
  }

  if (patternCache.has(cacheKey)) {
    return patternCache.get(cacheKey);
  }

  let isMatch;
  if (typeof targetPattern === 'string') isMatch = testValue == targetPattern;
  else if (targetPattern && typeof targetPattern.exec === 'function')
    isMatch = !!targetPattern.exec(testValue);
  else if (typeof targetPattern === 'boolean' || typeof targetPattern === 'object')
    isMatch = targetPattern;
  else if (typeof targetPattern === 'function') isMatch = targetPattern(testValue);
  else isMatch = false;

  patternCache.set(cacheKey, isMatch);
  cacheTimestamps.set(cacheKey, now);
  return isMatch;
};

/**
 * Creates a JSON stream parser.
 *
 * Note: This parser expects the input JSON to be chunked into valid JSON objects or arrays.
 * For very large or deeply nested JSON, partial parsing may be incomplete.
 *
 * @param {string|Array} pattern - JSONPath pattern or array of keys (e.g. 'foo.bar.*')
 * @param {Function} [transformFn] - Function to transform matched data
 * @returns {Transform} Transform stream emitting matched objects
 */
const createStreamParser = (pattern = '*', transformFn) => {
  if (pattern !== '*' && !Array.isArray(pattern) && typeof pattern !== 'string') {
    throw new TypeError('Pattern must be a string, array, or "*"');
  }
  if (transformFn !== undefined && typeof transformFn !== 'function') {
    throw new TypeError('TransformFn must be a function if provided');
  }

  let isArrayStart, isArrayEnd;
  let jsonBuffer = '';
  let bracketDepth = 0;
  let insideString = false;
  let isEscaped = false;
  let isDestroyed = false;

  // Support patterns like 'users.*' to extract objects at a path
  let normalizedPattern = pattern;
  if (typeof pattern === 'string') {
    normalizedPattern = pattern.split('.').map(element => {
      if (element === '*') return '*';
      return element;
    });
  }
  const activePattern =
    Array.isArray(normalizedPattern) && normalizedPattern.length ? normalizedPattern : null;

  const createTransformStream = (write, end, opts = {}) =>
    new Transform({
      objectMode: true,
      transform(chunk, _encoding, callback) {
        try {
          write.call(this, chunk);
          callback();
        } catch (err) {
          callback(err);
        }
      },
      flush(callback) {
        try {
          if (typeof end === 'function') end.call(this);
          callback();
        } catch (err) {
          callback(err);
        }
      },
      ...opts,
    });

  // Recursively walk the object to match the pattern
  const processValue = jsonValue => {
    if (isDestroyed) return;
    if (!activePattern) {
      stream.push(jsonValue);
      return;
    }
    const walk = (obj, patternArr, idx) => {
      if (idx === patternArr.length) {
        // Matched full pattern
        stream.push(obj);
        return;
      }
      const pat = patternArr[idx];
      if (pat === '*') {
        if (Array.isArray(obj)) {
          for (const item of obj) walk(item, patternArr, idx + 1);
        } else if (typeof obj === 'object' && obj !== null) {
          for (const key in obj) walk(obj[key], patternArr, idx + 1);
        }
      } else if (typeof obj === 'object' && obj !== null && pat in obj) {
        walk(obj[pat], patternArr, idx + 1);
      }
    };
    walk(jsonValue, activePattern, 0);
  };

  const stream = createTransformStream(
    chunk => {
      if (isDestroyed) return;

      const chunkStr = chunk.toString();
      for (let i = 0; i < chunkStr.length; i++) {
        const char = chunkStr[i];

        if (isEscaped) {
          isEscaped = false;
          jsonBuffer += char;
          continue;
        }

        if (char === '\\' && insideString) {
          isEscaped = true;
          jsonBuffer += char;
          continue;
        }

        if (char === '"' && !isEscaped) {
          insideString = !insideString;
        }

        if (!insideString) {
          if (char === '{' || char === '[') {
            bracketDepth++;
          } else if (char === '}' || char === ']') {
            bracketDepth--;
          }
        }

        jsonBuffer += char;

        // Try to parse complete JSON objects
        if (bracketDepth === 0 && (char === '}' || char === ']')) {
          try {
            const value = parseJSON(jsonBuffer);
            processValue(value);
            jsonBuffer = '';
          } catch (err) {
            // Not a complete JSON object yet, continue buffering
            if (jsonBuffer.length > 1024 * 1024) {
              // 1MB buffer limit
              stream.destroy(new Error('Buffer size exceeded while parsing JSON'));
            }
          }
        }
      }
    },
    () => {
      if (isDestroyed) return;

      if (jsonBuffer.trim()) {
        try {
          const value = parseJSON(jsonBuffer);
          processValue(value);
        } catch (err) {
          stream.emit('error', new Error('Invalid JSON at end of stream'));
        }
      }
      if (isArrayStart) stream.emit('isArrayStart', isArrayStart);
      if (isArrayEnd) stream.emit('isArrayEnd', isArrayEnd);
      stream.push(null);
    }
  );

  // Add cleanup method
  const originalDestroy = stream.destroy;
  stream.destroy = function (error) {
    isDestroyed = true;
    jsonBuffer = '';
    originalDestroy.call(this, error);
  };

  return stream;
};

/**
 * Reads a JSON file and returns both parsed and raw data
 * Supports streaming for large files and pattern-based data extraction
 *
 * @param {string} filePath
 * @param {Object} options
 * @param {string|Array} [options.jsonPathPattern='*']
 * @param {boolean} [options.includeRawData=false]
 * @param {string} [options.encoding='utf8']
 * @param {number} [options.maxBufferSize=1048576]
 * @param {number} [options.maxFileSize=104857600]
 * @returns {Promise<{parsed: Array, raw: string, isFileAccessible: boolean, error: Error}>}
 *
 * @example
 * (async () => {
 *   const { parsed, raw, isFileAccessible, error } = await readJSONFile('./data.json', {
 *     jsonPathPattern: ['users', '*', 'id'], // Example pattern
 *     includeRawData: true,
 *     maxFileSize: 50 * 1024 * 1024, // 50MB max
 *   });
 *
 *   if (error) {
 *     console.error('Failed to read JSON:', error);
 *     return;
 *   }
 *
 *   console.log('Parsed data:', parsed);
 *   console.log('Raw data:', raw);
 *   console.log('File accessible:', isFileAccessible);
 * })();
 */
const readJSONFile = async (
  filePath,
  {
    jsonPathPattern = '*',
    includeRawData = false,
    encoding = 'utf8',
    maxBufferSize = 1024 * 1024,
    maxFileSize = 1024 * 1024 * 100,
  } = {}
) => {
  const result = { parsed: [], raw: '', isFileAccessible: false, error: null };

  // Validate inputs, but do NOT throw — instead set error and return immediately
  if (typeof filePath !== 'string' || !filePath.trim()) {
    result.error = new TypeError('filePath must be a non-empty string');
    return result;
  }
  if (typeof maxBufferSize !== 'number' || maxBufferSize <= 0) {
    result.error = new TypeError('maxBufferSize must be a positive number');
    return result;
  }
  if (typeof maxFileSize !== 'number' || maxFileSize <= 0) {
    result.error = new TypeError('maxFileSize must be a positive number');
    return result;
  }

  let totalBufferSize = 0;
  let readStream = null;
  let jsonStream = null;

  try {
    const stats = await getPathInfo(filePath);
    if (!stats) {
      result.error = new Error(`File not found: ${filePath}`);
      return result;
    }
    if (stats.size === 0) throw new Error('File is empty');
    if (stats.size > maxFileSize)
      throw new Error(
        `File too large (${(stats.size / 1024 / 1024).toFixed(2)}MB). Max allowed: ${(maxFileSize / 1024 / 1024).toFixed(2)}MB`
      );

    result.isFileAccessible = true;

    readStream = fs.createReadStream(filePath, { encoding });

    jsonStream = createStreamParser(jsonPathPattern);

    const rawDataChunks = [];
    if (includeRawData) {
      readStream.on('data', chunk => {
        totalBufferSize += chunk.length;
        if (totalBufferSize > maxBufferSize) {
          readStream.destroy(
            new Error(`Buffer size exceeded (${(totalBufferSize / 1024 / 1024).toFixed(2)}MB)`)
          );
        }
        rawDataChunks.push(chunk);
      });
    }

    readStream.on('error', err => {
      result.error = new Error(`Error reading file: ${err.message}`);
      readStream.destroy(err);
    });

    jsonStream.on('error', err => {
      result.error = new Error(`Error parsing JSON: ${err.message}`);
      readStream.destroy(err);
    });

    await pipelineAsync(
      readStream,
      jsonStream,
      new Transform({
        objectMode: true,
        transform(chunk, _, callback) {
          try {
            if (Array.isArray(chunk)) result.parsed.push(...chunk);
            else result.parsed.push(chunk);
            callback();
          } catch (error) {
            callback(error);
          }
        },
      })
    );

    if (includeRawData && rawDataChunks.length) {
      result.raw = rawDataChunks.join('');
    }
  } catch (error) {
    console.error(`Error reading JSON file at ${filePath}:`, error);
    result.error = result.error || error;
  } finally {
    cleanupStream(readStream);
    cleanupStream(jsonStream);
  }
  return result;
};

/**
 * Writes data to a JSON file with chunked writing and progress tracking.
 * Atomic write with file locking and directory creation.
 *
 * @param {string} filePath
 * @param {Array<any>} data
 * @param {Object} options
 * @param {number} [options.chunkSize=100] - Number of items per write chunk (not bytes)
 * @param {boolean} [options.pretty=false]
 * @param {function} [options.onProgress]
 * @param {number} [options.batchSize=1000] - Number of items to process per batch
 * @param {function} [options.replacer] - Optional replacer function for stringifying
 * @returns {Promise<boolean>}
 *
 * @example
 * (async () => {
 *   const data = [{ id: 1 }, { id: 2 }, { id: 3 }];
 *
 *   const success = await writeJSONFile('./output.json', data, {
 *     chunkSize: 2,
 *     pretty: true,
 *     onProgress: ({ processed, total, percentage }) => {
 *       console.log(`Progress: ${processed}/${total} (${percentage}%)`);
 *     },
 *   });
 *
 *   console.log('Write success:', success);
 * })();
 */
const writeJSONFile = async (
  filePath,
  data,
  { chunkSize = 100, pretty = false, onProgress, batchSize = 1000, replacer } = {}
) => {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { success: false, error: new TypeError('Invalid file path') };
  }

  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    return { success: false, error: new RangeError('chunkSize must be a positive integer') };
  }

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    return { success: false, error: new RangeError('batchSize must be a positive integer') };
  }

  const lockHandler = withMutex(filePath);
  await lockHandler.lock();

  const tempFilePath = filePath + '.tmp';
  let writeStream = null;
  let writeError = null;
  try {
    await createDirectory(path.dirname(filePath));

    writeStream = fs.createWriteStream(tempFilePath, { encoding: 'utf8' });
    writeStream.setMaxListeners(30);

    // Capture write errors asynchronously
    const writeErrorPromise = new Promise((_, reject) => {
      writeStream.on('error', error => {
        writeError = error;
        reject(new Error(`Error writing to file ${tempFilePath}: ${error.message}`));
      });
    });

    writeStream.write(pretty ? '[\n' : '[');

    let processed = 0;
    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);

      for (let j = 0; j < batch.length; j += chunkSize) {
        const chunk = batch.slice(j, j + chunkSize);
        const isLastChunk = i + j + chunk.length >= data.length;

        const jsonChunk = chunk
          .map(item => stringifyJSON(item, replacer, pretty ? 2 : 0))
          .join(pretty ? ',\n' : ',');

        const writeData = isLastChunk ? jsonChunk : jsonChunk + ',';

        if (!writeStream.write(writeData)) {
          await Promise.race([
            new Promise((resolve, reject) => {
              writeStream.once('drain', resolve);
              writeStream.once('error', reject);
            }),
            writeErrorPromise,
          ]);
        }
        processed += chunk.length;
      }
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            processed: Math.min(processed, data.length),
            total: data.length,
            percentage: Math.round((Math.min(processed, data.length) / data.length) * 100),
          });
        } catch {}
      }
    }

    writeStream.end(pretty ? '\n]\n' : ']');

    await Promise.race([
      new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      }),
      writeErrorPromise,
    ]);

    if (writeError) throw writeError;

    // Attempt atomic rename, handle possible cross-device or permission errors
    const renameResult = await safeRenameTempFile(tempFilePath, filePath);
    if (!renameResult.success) return renameResult;

    return { success: true };
  } catch (error) {
    return { success: false, error };
  } finally {
    lockHandler.unlock();
    cleanupStream(writeStream);
    await safeCleanupTempFile(tempFilePath);
  }
};

/**
 * Atomically rename a temp file to the target file, cleaning up on failure.
 * @param {string} tempFilePath
 * @param {string} filePath
 * @returns {Promise<{success: boolean, error?: Error}>}
 */
const safeRenameTempFile = async (tempFilePath, filePath) => {
  try {
    await fs.promises.rename(tempFilePath, filePath);
    return { success: true };
  } catch (renameErr) {
    try {
      await fs.promises.unlink(tempFilePath);
    } catch (unlinkErr) {
      console.error('Failed to rename and failed to unlink temp file:', renameErr, unlinkErr);
      return {
        success: false,
        error: new Error(
          `Failed to rename temp file: ${renameErr.message}; and failed to unlink: ${unlinkErr.message}`
        ),
      };
    }
    console.error('Failed to rename temp file:', renameErr);
    return {
      success: false,
      error: new Error(`Failed to rename temp file: ${renameErr.message}`),
    };
  }
};

/**
 * Remove a temp file if it exists, logging errors but not throwing.
 * @param {string} tempFilePath
 */
async function safeCleanupTempFile(tempFilePath) {
  try {
    const stat = await getPathInfo(tempFilePath);
    if (stat) {
      if (stat.isDirectory()) {
        await fs.promises.rm(tempFilePath, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(tempFilePath);
      }
    }
  } catch (cleanupErr) {
    console.error('Cleanup: failed to unlink/rmdir temp file:', cleanupErr);
  }
}

module.exports = {
  readJSONFile,
  writeJSONFile,
};
